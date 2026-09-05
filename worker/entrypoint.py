#!/usr/bin/env python3
"""Sattori 録画ワーカーのエントリポイント。

EC2 Fleet インスタンスの UserData から `docker run` で起動される。処理の流れ:
  1. 生動画チェックポイント(S3の`videos/{jobId}.mp4`)の有無を確認する。既にあれば
     「変換から再開」(録画をスキップし、S3から生動画をダウンロードする)。これは
     録画完了後・変換中にSpot中断でリトライになった場合、録画からやり直さず変換だけ
     再実行できるようにするためのもの(Issue #11)。併せてDynamoDBのジョブレコードも
     確認し、既に`done`なら完了済みジョブの重複実行として何もせず成功通知する。
  2. (通常経路) GAME環境変数に応じたタイトル固有アセット(ゲーム本体+WINEPREFIX+MOD)が
     未展開ならS3からダウンロード・展開(title_assets.py、Issue #22。ワーカーイメージ
     自体はタイトル数に依存しない共通部分のみで構成し、タイトル固有アセットは実行時に
     取得する) → S3からリプレイをダウンロード → recording状態 → GAMEに応じた
     record_{game}.py(recording/パッケージの共通録画パイプラインを使う、Issue #13)
     で録画(ProgressReporterが録画中のスクリーンショット/進捗をS3・DynamoDBへ反映する)
  3. 録画完了直後、生動画をS3へアップロードしoutputPathを保存(=チェックポイント) →
     status を converting に更新(併せてリプレイずれの事後検証結果 desyncDetected、
     タイムアウト打ち切りの有無 timedOut も書き込む。Issue #103・#161。
     recording.modlog.check_replay_desync() / recording.pipeline.attempt_recording() 参照)
  4. 配信用変換(等倍への戻し・解像度合わせ・ウォーターマーク合成を1パスで。
     進捗%を10秒間隔程度で報告)
  5. 変換後動画をS3へアップロード → status を done に更新。出力が1本か2本かは
     録画の内容で決まる(`convert.needs_separate_raw_output()`、下記 convert_and_upload)

バックグラウンドでは2つのスレッドが動く。TaskHeartbeat は Step Functions へ60秒間隔で
`SendTaskHeartbeat` を送り、ワーカーが生きていることを知らせる(Issue #49。自宅ワーカーの
停電・回線断はAWS側から観測できないため、これが唯一の死活監視になる)。もう1つ、
InterruptionWatcher が Spot中断通知(実際に発効する2分前通知)を
監視する。IMDSが無い自宅ワーカーでは起動しない(`SPOT_INTERRUPTION_WATCH`環境変数、
Issue #96)。検知次第 taskToken 経由で Step Functions に早期失敗通知する(60分のタイムアウトを
待たずに新インスタンスでのリトライを開始させるため)。録画/変換処理自体はそのまま
続行する(中断が実際に発効するまで、できるところまで進める)。リバランス推奨(発効するとは
限らない予測的シグナル)は失敗扱いにせずログにのみ記録し処理を継続する(EC2 Fleetの
AllocationStrategyがコスト優先の`lowest-price`固定でリバランス推奨自体は起きやすいため、
そのまま早期失敗の合図にすると不要なリトライが増えてしまう)。

成功/失敗の確定は DynamoDB の status 更新とは別に、taskToken 経由の
SendTaskSuccess/SendTaskFailure で Step Functions にも通知する。

ジョブ固有の値はすべて環境変数で渡される(apps/api の ec2.buildUserData /
handlers/sfn/launch.ts 参照)。
"""
import json
import os
import subprocess
import sys
import threading
import time

import boto3

import pulse
from convert import convert_for_delivery, needs_separate_raw_output, probe_resolution
from interruption_watcher import InterruptionWatcher
from progress_reporter import ProgressReporter
from recording import slow_motion_scale
from status import get_job, update_progress, update_status
from task_heartbeat import TaskHeartbeat
from title_assets import ensure_title_assets

JOB_ID = os.environ["JOB_ID"]
GAME = os.environ.get("GAME", "th07")
REPLAY_BUCKET = os.environ["REPLAY_BUCKET"]
REPLAY_KEY = os.environ["REPLAY_KEY"]
OUTPUT_BUCKET = os.environ["OUTPUT_BUCKET"]
TITLE_ASSETS_BUCKET = os.environ["TITLE_ASSETS_BUCKET"]
WATERMARK = os.environ.get("WATERMARK", "1") == "1"
# EC2 Fleetでのみ有効(Issue #96)。IMDSが無い自宅ワーカーでは`SPOT_INTERRUPTION_WATCH`が
# 渡されず、常にタイムアウトし続けるだけの`InterruptionWatcher`を起動しない
# (`apps/api/src/workerEnv.ts`の`spotInterruptionWatch`が起動側の判断を渡す)。
SPOT_INTERRUPTION_WATCH = os.environ.get("SPOT_INTERRUPTION_WATCH", "0") == "1"
TASK_TOKEN = os.environ.get("TASK_TOKEN")
EXPECTED_DURATION_SECONDS = os.environ.get("EXPECTED_DURATION_SECONDS")
# リプレイファイルに記録された最終スコア(画面表示値)。apps/api/src/workerEnv.tsが
# job.replayInfo.scoreから転記する(未取得なら未設定)。リプレイずれの事後検証
# (Issue #103、recording.modlog.check_replay_desync())に使う。
EXPECTED_SCORE = os.environ.get("EXPECTED_SCORE")

REPO = "/app"
WORK_DIR = f"/app/runs/{JOB_ID}"
REPLAY_PATH = f"{WORK_DIR}/upload.rpy"
OUTPUT_VIDEO = f"{WORK_DIR}/video.mp4"
OUTPUT_VIDEO_DELIVERY = f"{WORK_DIR}/video_delivery.mp4"
PROGRESS_DIR = f"{WORK_DIR}/progress"
# 録画試行を破棄した際の最終フレーム(調査用の証跡、Issue #159)の書き出し先。
# record_thNN.py(recording.artifacts.save_diagnostics_snapshot())が書き、progress/と
# 違い頻繁な更新が無いため常駐スレッドは持たず、record()完了後にまとめてS3へ
# アップロードする(upload_diagnostics_snapshots_if_present()参照)。
DIAGNOSTICS_DIR = f"{WORK_DIR}/diagnostics"
# リプレイずれ検証(Issue #103)の結果。record_thNN.pyは別プロセスのため、戻り値を
# ファイル経由で受け渡す(recording.artifacts.write_desync_result()が書く)。
DESYNC_RESULT_PATH = f"{WORK_DIR}/desync_result.json"
# リプレイ終了を検知できずタイムアウトで打ち切られたか(Issue #161)の結果。
# DESYNC_RESULT_PATHと同じくrecording.artifacts.write_timeout_result()がファイル経由で書く。
TIMEOUT_RESULT_PATH = f"{WORK_DIR}/timeout_result.json"
# 出力オブジェクトキー。CloudFront はこのキーをパスとして配信する。
# `OUTPUT_KEY` は録画直後の生データ(チェックポイント)の置き場でもある。
# `_720p` という接尾辞は歴史的なもので、実際の解像度は録画によって変わる
# (720pに満たない録画だけ引き上げ、th20の1280x960はそのまま。`convert.py`参照)。
OUTPUT_KEY = f"videos/{JOB_ID}.mp4"
OUTPUT_KEY_DELIVERY = f"videos/{JOB_ID}_720p.mp4"
# 生データのチェックポイントに添えるS3オブジェクトメタデータのキー。低速録画
# (Issue #68)の生データは実時間が `time_scale` 倍に伸びており、等倍へ戻すには
# その倍率が要る。**環境変数から取り直してはいけない**: 自宅ワーカーが低速で
# 録画した後にリトライがEC2へ回ると、EC2側には`FPS_LIMIT_TARGET_HZ`が渡らないため、
# 半分の速度の動画をそのまま配信してしまう。倍率は生データ自身に添えて運ぶ。
TIME_SCALE_METADATA_KEY = "sattori-time-scale"
WATERMARK_ASSET = f"{REPO}/assets/watermark/watermark-60fps.webm"
# 配信用変換中のffmpeg生ログ(frame=/fps=/bitrate=等)の退避先。CloudWatch Logsには
# 全行流さず(Issue #58フォローアップ)、ここへ書き出してから完了後にS3(期限付き)へ
# アップロードする。CloudFrontでは配信しない診断用データのため、動画とは別プレフィックス
# にする(infra/lib/sattori-stack.tsで短めのライフサイクルルールを設定)。
FFMPEG_UPSCALE_LOG = f"{WORK_DIR}/ffmpeg_upscale.log"
FFMPEG_UPSCALE_LOG_KEY = f"worker-logs/{JOB_ID}/ffmpeg-upscale.log"

# GAME に応じたタイトル固有の録画スクリプト(Issue #13でth08、th06対応・th11対応で追加)。
# 辞書で明示的に許可した値のみを使うことで、job.game由来のGAME環境変数から
# 任意のパスを組み立てないようにする(値自体はapps/api側でisSupportedGameを
# 通過したものしかジョブ化されないが、念のための防御)。
RECORDING_SCRIPTS = {
    "th06": "record_th06.py",
    "th07": "record_th07.py",
    "th08": "record_th08.py",
    "th09": "record_th09.py",
    "th10": "record_th10.py",
    "th11": "record_th11.py",
    "th12": "record_th12.py",
    "th20": "record_th20.py",
}

_sfn = None
# taskTokenへの通知(SendTaskSuccess/SendTaskFailure)は一度きり。中断検知による
# 早期失敗通知と、main()末尾での成功/失敗通知が競合しないようにする。
_notified = threading.Event()


def log(msg):
    print(f"[entrypoint {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def _sfn_client():
    global _sfn
    if _sfn is None:
        _sfn = boto3.client("stepfunctions")
    return _sfn


def notify_task_result(success, error_message=None):
    if not TASK_TOKEN or _notified.is_set():
        return
    _notified.set()
    try:
        if success:
            _sfn_client().send_task_success(taskToken=TASK_TOKEN, output="{}")
        else:
            _sfn_client().send_task_failure(
                taskToken=TASK_TOKEN,
                error="WorkerFailed",
                cause=str(error_message or "")[:32000],
            )
    except Exception as err:  # noqa: BLE001 - 通知に失敗しても後続処理は止めない
        log(f"taskTokenへの通知に失敗しました(継続): {err}")


def on_interruption(reason, detail):
    """Spot中断通知(実際に発効する2分前通知)を検知した際のコールバック。
    録画/変換処理自体は止めず、Step Functions側だけ早期に失敗させて新インスタンス
    でのリトライを促す。リバランス推奨(発効するとは限らない予測的シグナル)では
    InterruptionWatcher 側がこのコールバックを呼ばないため、reason は常に
    "spot_interruption" になる。

    注: 通知後もこのインスタンスの処理は継続するため、taskToken 通知後に
    たまたま処理が完了するケースもあり得る。その場合でも taskToken は既に
    失敗として消費済みのため再度成功通知はしない(Step Functions側は別
    インスタンスで並行リトライ中)。HandleFailure Lambda がこの通知を受けて
    このインスタンスを速やかに terminate するため、二重完了の実害は限定的。
    """
    log(f"中断通知を検知しました: {reason} {detail}")
    notify_task_result(False, error_message=f"SpotInterrupted: {reason} {detail}")


def start_pulseaudio():
    # デーモンを起動するだけで、sink はここでは作らない。録音に使うジョブ専用の
    # null-sink は録画スクリプト側(recording.pipeline.record_with_retry →
    # pulse.job_sink)が作成・破棄する(Issue #48)。デフォルト sink(`auto_null`)には
    # 依存しない設計のため、専用 sink のロードに伴って `module-always-sink` が
    # `auto_null` を落としても実害はない(touhou-recorder reports/41)。
    log("pulseaudio を起動します")
    subprocess.run(["pulseaudio", "-D", "--exit-idle-time=-1", "--disallow-exit"], check=False)
    time.sleep(2.0)


def download_replay(s3):
    log(f"リプレイをダウンロード: s3://{REPLAY_BUCKET}/{REPLAY_KEY}")
    s3.download_file(REPLAY_BUCKET, REPLAY_KEY, REPLAY_PATH)


def download_checkpoint_video(s3):
    log(f"生動画をダウンロード(変換から再開): s3://{OUTPUT_BUCKET}/{OUTPUT_KEY}")
    s3.download_file(OUTPUT_BUCKET, OUTPUT_KEY, OUTPUT_VIDEO)


def upload_video(s3, path, key, metadata=None):
    """動画をS3へアップロードし、そのバイト数を返す。

    サイズは管理画面のコスト推定(Issue #60、packages/shared/src/cost.ts)で
    S3保管料とCloudFront配信量の入力になる。動画サイズは本サービスのコスト構造で
    最大のレバレッジ(docs/research/aws-region-cost-analysis.md §6)なので、平均値で丸めず
    ジョブ単位の実測をDynamoDBへ残す。
    """
    size = os.path.getsize(path)
    log(f"動画をアップロード: s3://{OUTPUT_BUCKET}/{key} ({size}バイト)")
    extra = {"ContentType": "video/mp4"}
    if metadata:
        extra["Metadata"] = metadata
    s3.upload_file(path, OUTPUT_BUCKET, key, ExtraArgs=extra)
    return size


def raw_checkpoint_exists(s3):
    """変換から再開できる生データのチェックポイントがS3に在るか。

    **ジョブレコードの `outputPath` では判定できない**。出力を1本に集約する構成
    (`convert.py` の `needs_separate_raw_output()` が False——th20や低速録画)では、
    完了時に `outputPath` が変換結果を指し、生データは削除される。完了済みのジョブが
    Step Functions にリトライされた場合(ハートビート途切れなどで、コンテナ自体は
    完走していたケース)に「`outputPath` があるから再開できる」と誤認すると、存在
    しない生データを取りに行って落ち、`done` を `failed` へ書き換えてしまう。
    実体の有無をS3へ直接聞くこと。

    取得に失敗した場合は「無い」とみなす。録画からやり直す分だけ実時間を捨てるが、
    出来上がるものは正しい。
    """
    try:
        s3.head_object(Bucket=OUTPUT_BUCKET, Key=OUTPUT_KEY)
        return True
    except Exception as err:  # noqa: BLE001 - 404も一時障害も「再開しない」に倒す
        log(f"生データのチェックポイントは見つかりませんでした(録画から開始): {err}")
        return False


def read_checkpoint_time_scale(s3):
    """生データのチェックポイントに添えた実時間スケールを読む(既定1.0＝等倍)。

    取得に失敗した場合も1.0へ倒す。低速録画で録った生データを等倍とみなすと
    半分の速度の動画を配信してしまうが、ここで例外にすると**変換から再開できる
    はずだったジョブを録画からやり直させる**ことになる。メタデータが欠けるのは
    このフィールド導入前のジョブか、S3の一時障害に限られるため、ログを残して
    続行する側に倒す。
    """
    try:
        head = s3.head_object(Bucket=OUTPUT_BUCKET, Key=OUTPUT_KEY)
        raw = (head.get("Metadata") or {}).get(TIME_SCALE_METADATA_KEY)
        if raw is None:
            log(f"生データに{TIME_SCALE_METADATA_KEY}が無いため等倍として扱います")
            return 1.0
        return float(raw)
    except Exception as err:  # noqa: BLE001 - 取得失敗で変換からの再開自体を諦めない
        log(f"生データのメタデータ取得に失敗しました(等倍として続行): {err}")
        return 1.0


def upload_diagnostics_snapshots_if_present(s3):
    """録画試行を破棄した際の最終フレーム(Issue #159)をS3へアップロードする(存在する
    場合のみ)。ユーザー向けプレビュー(`progress/`)とは別の調査用の証跡なので、
    別プレフィックス(`diagnostics/{jobId}/`)へ置く。record()が録画の成否を判定する前に
    呼ぶこと(失敗時こそ診断に必要なため)。アップロード自体の失敗はジョブ全体を
    失敗させない(upload_ffmpeg_upscale_log_if_present()と同じ方針)。
    """
    if not os.path.isdir(DIAGNOSTICS_DIR):
        return
    for filename in sorted(os.listdir(DIAGNOSTICS_DIR)):
        path = f"{DIAGNOSTICS_DIR}/{filename}"
        key = f"diagnostics/{JOB_ID}/{filename}"
        log(f"診断用スクリーンショットをアップロード: s3://{OUTPUT_BUCKET}/{key}")
        try:
            s3.upload_file(path, OUTPUT_BUCKET, key, ExtraArgs={"ContentType": "image/jpeg"})
        except Exception as err:  # noqa: BLE001 - 診断データのアップロード失敗でジョブ全体を失敗させない
            log(f"診断用スクリーンショットのアップロードに失敗しました(継続): {err}")


def upload_ffmpeg_upscale_log_if_present(s3):
    """720p変換のffmpeg生ログをS3へアップロードする(存在する場合のみ)。変換の
    成功/失敗どちらでも診断に使えるため、呼び出し側はconvert_for_delivery()の成否に
    かかわらず(finallyで)呼ぶ。アップロード自体の失敗はジョブ全体を失敗させない
    (診断データの欠落より、既に完了した変換結果を無駄にする方が損失が大きいため)。
    """
    if not os.path.exists(FFMPEG_UPSCALE_LOG):
        return
    log(f"ffmpeg変換ログをアップロード: s3://{OUTPUT_BUCKET}/{FFMPEG_UPSCALE_LOG_KEY}")
    try:
        s3.upload_file(
            FFMPEG_UPSCALE_LOG, OUTPUT_BUCKET, FFMPEG_UPSCALE_LOG_KEY,
            ExtraArgs={"ContentType": "text/plain; charset=utf-8"},
        )
    except Exception as err:  # noqa: BLE001 - 診断ログのアップロード失敗でジョブ全体を失敗させない
        log(f"ffmpeg変換ログのアップロードに失敗しました(継続): {err}")


def record(s3):
    """録画を実行し、完了直後に生動画をS3へチェックポイントとしてアップロードする。"""
    ensure_title_assets(s3, TITLE_ASSETS_BUCKET, GAME, log=log)
    download_replay(s3)
    start_pulseaudio()
    # リトライで再入した場合、progress には前の試行の値が残っている。status と同じ
    # 更新で 0 に戻し、「録画中 + 前の試行の進捗」が見える窓を作らない(Issue #108)。
    update_status(JOB_ID, "recording", reset_progress=True)

    script = RECORDING_SCRIPTS.get(GAME)
    if script is None:
        raise RuntimeError(f"対応していないタイトルです: game={GAME}")

    progress_reporter = ProgressReporter(s3, OUTPUT_BUCKET, JOB_ID, PROGRESS_DIR, log=log)
    progress_reporter.start()
    try:
        cmd = [
            "python3", f"{REPO}/{script}",
            "--replay-path", REPLAY_PATH,
            "--output", OUTPUT_VIDEO,
            "--progress-dir", PROGRESS_DIR,
            "--diagnostics-dir", DIAGNOSTICS_DIR,
            # 音声の録音先をこのジョブ専用のPulseAudio sinkに固定する(Issue #48)。
            # 1インスタンス=1ジョブのEC2 Fleetでは分離の必要はないが、コードパスを
            # 分岐させない方針のため常に渡す。
            "--pulse-sink", pulse.sink_name_for_job(JOB_ID),
        ]
        if EXPECTED_DURATION_SECONDS:
            cmd += ["--expected-duration-seconds", EXPECTED_DURATION_SECONDS]
        if EXPECTED_SCORE:
            cmd += ["--expected-score", EXPECTED_SCORE]
        cmd += ["--desync-result-path", DESYNC_RESULT_PATH]
        cmd += ["--timeout-result-path", TIMEOUT_RESULT_PATH]

        result = subprocess.run(cmd)
    finally:
        progress_reporter.stop()

    upload_diagnostics_snapshots_if_present(s3)

    if result.returncode != 0 or not os.path.exists(OUTPUT_VIDEO):
        raise RuntimeError(f"録画に失敗しました (exit_code={result.returncode})")

    # 変換前に生動画をチェックポイントとしてアップロードする。以降Spot中断で
    # リトライになっても、次の試行はここから(変換のみ)再開できる。
    # 低速録画(Issue #68)ならこの生データは実時間が伸びた状態なので、等倍へ戻すのに
    # 要る倍率をオブジェクトメタデータとして添える(`TIME_SCALE_METADATA_KEY`参照)。
    time_scale = slow_motion_scale()
    output_bytes = upload_video(
        s3, OUTPUT_VIDEO, OUTPUT_KEY, metadata={TIME_SCALE_METADATA_KEY: str(time_scale)},
    )
    update_status(
        JOB_ID, "converting", output_path=OUTPUT_KEY, output_bytes=output_bytes,
        # 録画フェーズ末尾の進捗(=リプレイ全長)を持ち越さない。status だけ先に
        # 書き換えると、変換フェーズの進捗が届くまでの数秒間「変換中 100%」に
        # 見えてしまう(Issue #108)。
        reset_progress=True,
        desync_detected=read_desync_result(),
        timed_out=read_timeout_result(),
    )


def read_desync_result():
    """record_thNN.pyが書き出したリプレイずれ検証結果(Issue #103)を読む。

    True/False が判明した場合のみ返し、未検証(ファイル無し・null)の場合は
    Noneを返す(update_status()はNoneなら`desyncDetected`属性に触れない)。
    """
    if not os.path.exists(DESYNC_RESULT_PATH):
        return None
    try:
        with open(DESYNC_RESULT_PATH) as f:
            data = json.load(f)
        detected = data.get("desyncDetected")
        return detected if isinstance(detected, bool) else None
    except (OSError, ValueError) as err:  # noqa: BLE001 - 診断結果の読み取り失敗でジョブは失敗させない
        log(f"リプレイずれ検証結果の読み取りに失敗しました(継続): {err}")
        return None


def read_timeout_result():
    """record_thNN.pyが書き出したタイムアウト打ち切り結果(Issue #161)を読む。

    read_desync_result()と同じ方式(True/False判明時のみ返し、それ以外はNone)。
    """
    if not os.path.exists(TIMEOUT_RESULT_PATH):
        return None
    try:
        with open(TIMEOUT_RESULT_PATH) as f:
            data = json.load(f)
        timed_out = data.get("timedOut")
        return timed_out if isinstance(timed_out, bool) else None
    except (OSError, ValueError) as err:  # noqa: BLE001 - 診断結果の読み取り失敗でジョブは失敗させない
        log(f"タイムアウト打ち切り結果の読み取りに失敗しました(継続): {err}")
        return None


def convert_and_upload(s3, time_scale):
    """録画結果を配信用の1本へ変換し、S3とDynamoDBへ反映する。

    **録画後の再エンコードはこの1パスだけ**で、等倍への戻し(低速録画)・解像度合わせ・
    ウォーターマーク合成をまとめて行う(`convert.py`)。

    出力が1本になるか2本になるかは録画の内容で決まる(`needs_separate_raw_output()`):

    - **2本**(th06/07/08/11の等倍録画): 生データがそのまま「元解像度版」として通用する。
      既にチェックポイントとしてアップロード済みなので、変換結果を別キーへ足すだけ。
    - **1本**(th20・低速録画): 生データを別に出す意味が無い(解像度が同じでウォーター
      マークの有無しか違わない)か、半分の速度でそのままでは配信できない。変換結果だけを
      配信し、**役目を終えた生データはS3から消す**(消さないとジョブあたりの保管量が
      倍のまま残り、CloudFrontの無料枠を圧迫する。AGENTS.md §6)。
    """
    # 変換フェーズの進捗をここから数え直す。上の record() から来た場合は
    # 「converting へ遷移した書き込み」が既に 0 へ戻しているが、生動画チェックポイント
    # からの再開(record() を丸ごと飛ばす経路)ではその書き込み自体が無く、前の試行の
    # 変換進捗が残ったままになる。status を伴う更新にしてあるのは、progress だけを
    # 単独で戻すと status との整合が一瞬崩れるため(Issue #108、status.py 参照)。
    update_status(JOB_ID, "converting", reset_progress=True)

    def on_convert_progress(seconds):
        update_progress(JOB_ID, round(seconds))

    width, height = probe_resolution(OUTPUT_VIDEO)
    separate_raw = needs_separate_raw_output(width, height, time_scale)

    try:
        convert_for_delivery(
            OUTPUT_VIDEO, OUTPUT_VIDEO_DELIVERY,
            time_scale=time_scale,
            watermark_path=WATERMARK_ASSET if WATERMARK else None,
            on_progress=on_convert_progress, log=log,
            ffmpeg_log_path=FFMPEG_UPSCALE_LOG,
        )
    finally:
        # 変換の成否にかかわらずアップロードする(失敗時こそ診断に必要なため)。
        upload_ffmpeg_upscale_log_if_present(s3)

    delivery_bytes = upload_video(s3, OUTPUT_VIDEO_DELIVERY, OUTPUT_KEY_DELIVERY)
    if separate_raw:
        update_status(
            JOB_ID, "done",
            output_path=OUTPUT_KEY, output_path_720p=OUTPUT_KEY_DELIVERY,
            # 生動画のサイズもここで併せて記録する。チェックポイントから再開した場合
            # (record()を通らず download_checkpoint_video() で取得した場合)は
            # record() 側の記録が走らないため。
            output_bytes=os.path.getsize(OUTPUT_VIDEO),
            output_bytes_720p=delivery_bytes,
        )
        return

    # 1本に集約する場合。`outputPath` を変換結果へ差し替え、`outputPath720p` は
    # null のままにする(ページBのダウンロードボタンは `downloadUrl720p ?? downloadUrl`
    # のフォールバックでそのまま1本になる)。
    update_status(
        JOB_ID, "done",
        output_path=OUTPUT_KEY_DELIVERY,
        output_bytes=delivery_bytes,
    )
    # **`done` を確定させてから**生データを消す。順序を逆にすると、削除後・status更新前に
    # 落ちた場合に「outputPathの指すオブジェクトが無い」ジョブが残り、変換からの再開も
    # できなくなる。ここまで来ていれば再開はもう起こらないので、削除は純粋な後始末。
    delete_raw_checkpoint(s3)


def delete_raw_checkpoint(s3):
    """役目を終えた生データのチェックポイントをS3から削除する(失敗しても続行)。"""
    try:
        s3.delete_object(Bucket=OUTPUT_BUCKET, Key=OUTPUT_KEY)
        log(f"生データのチェックポイントを削除しました: s3://{OUTPUT_BUCKET}/{OUTPUT_KEY}")
    except Exception as err:  # noqa: BLE001 - 完了済みジョブを削除失敗で失敗扱いにしない
        # 残ってもライフサイクルルール(OUTPUT_RETENTION_DAYS日)でいずれ消える。
        log(f"生データのチェックポイント削除に失敗しました(継続): {err}")


def main():
    os.makedirs(WORK_DIR, exist_ok=True)
    s3 = boto3.client("s3")
    log(f"ジョブ開始 job_id={JOB_ID} game={GAME} watermark={WATERMARK}")

    watcher = InterruptionWatcher(on_interruption, log=log) if SPOT_INTERRUPTION_WATCH else None
    if watcher:
        watcher.start()

    # Step Functions への死活通知(Issue #49)。ジョブの最初から最後まで動かす
    # (録画中だけでなく、タイトル資産のダウンロードや720p変換の最中も対象)。
    heartbeat = TaskHeartbeat(TASK_TOKEN, log=log)
    heartbeat.start()

    try:
        job = get_job(JOB_ID)

        if job and job.get("status") == "done":
            # 完了済みジョブの重複実行。コンテナは完走していたのにハートビートが
            # 途切れて Step Functions がリトライした、という経路で起こりうる
            # (`home-worker/README.md` §3)。動画は既にS3にあり status も `done` な
            # ので、録画をやり直しても同じものが出来るだけ——実時間を数十分捨て、
            # 完了メールをもう一度飛ばす分だけ悪い。何もせず成功として通知する。
            log("ジョブは既に完了しています。録画をやり直さず成功として通知します")
        else:
            if raw_checkpoint_exists(s3):
                log("生動画チェックポイントを検出しました。変換から再開します")
                download_checkpoint_video(s3)
                # 録画時の実時間スケールは生データ自身に添えてある。環境変数から
                # 取り直すと、自宅ワーカーが低速で録った後にEC2でリトライされた場合に
                # 半分の速度のまま配信してしまう(`TIME_SCALE_METADATA_KEY`参照)。
                time_scale = read_checkpoint_time_scale(s3)
            else:
                record(s3)
                time_scale = slow_motion_scale()

            convert_and_upload(s3, time_scale)

        log("ジョブ完了")
        if watcher:
            watcher.stop()
        heartbeat.stop()
        notify_task_result(True)
    except Exception as err:  # noqa: BLE001 - 失敗はすべて failed として記録する
        if watcher:
            watcher.stop()
        heartbeat.stop()
        log(f"ERROR: {err}")
        if not _notified.is_set():
            update_status(
                JOB_ID, "failed",
                error="録画処理中にエラーが発生しました", error_code="recording_failed",
            )
        notify_task_result(False, error_message=str(err))
        sys.exit(1)


if __name__ == "__main__":
    main()
