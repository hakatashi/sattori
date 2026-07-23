#!/usr/bin/env python3
"""Sattori 録画ワーカーのエントリポイント。

EC2 Fleet インスタンスの UserData から `docker run` で起動される。処理の流れ:
  1. DynamoDBのジョブレコードを確認する。生動画チェックポイント(outputPath)が
     既にあれば「変換から再開」(録画をスキップし、S3から生動画をダウンロードする)。
     これは録画完了後・変換中にSpot中断でリトライになった場合、録画からやり直さず
     変換だけ再実行できるようにするためのもの(Issue #11)。
  2. (通常経路) GAME環境変数に応じたタイトル固有アセット(ゲーム本体+WINEPREFIX+MOD)が
     未展開ならS3からダウンロード・展開(title_assets.py、Issue #22。ワーカーイメージ
     自体はタイトル数に依存しない共通部分のみで構成し、タイトル固有アセットは実行時に
     取得する) → S3からリプレイをダウンロード → recording状態 → GAMEに応じた
     record_{game}.py(recording_common.pyの共通録画パイプラインを使う、Issue #13)
     で録画(ProgressReporterが録画中のスクリーンショット/進捗をS3・DynamoDBへ反映する)
  3. 録画完了直後、生動画をS3へアップロードしoutputPathを保存(=チェックポイント) →
     status を converting に更新
  4. 720pへアップスケール変換(進捗%を10秒間隔程度で報告)
  5. 変換後動画をS3へアップロード → status を done に更新(outputPath/outputPath720p 確定)

バックグラウンドで InterruptionWatcher が Spot中断通知(実際に発効する2分前通知)を
監視し、検知次第 taskToken 経由で Step Functions に早期失敗通知する(60分のタイムアウトを
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
import os
import subprocess
import sys
import threading
import time

import boto3

from interruption_watcher import InterruptionWatcher
from progress_reporter import ProgressReporter
from status import get_job, update_progress, update_status
from title_assets import ensure_title_assets
from upscale import upscale_to_720p

JOB_ID = os.environ["JOB_ID"]
GAME = os.environ.get("GAME", "th07")
REPLAY_BUCKET = os.environ["REPLAY_BUCKET"]
REPLAY_KEY = os.environ["REPLAY_KEY"]
OUTPUT_BUCKET = os.environ["OUTPUT_BUCKET"]
TITLE_ASSETS_BUCKET = os.environ["TITLE_ASSETS_BUCKET"]
WATERMARK = os.environ.get("WATERMARK", "1") == "1"
TASK_TOKEN = os.environ.get("TASK_TOKEN")
EXPECTED_DURATION_SECONDS = os.environ.get("EXPECTED_DURATION_SECONDS")

REPO = "/app"
WORK_DIR = f"/app/runs/{JOB_ID}"
REPLAY_PATH = f"{WORK_DIR}/upload.rpy"
OUTPUT_VIDEO = f"{WORK_DIR}/video.mp4"
OUTPUT_VIDEO_720P = f"{WORK_DIR}/video_720p.mp4"
PROGRESS_DIR = f"{WORK_DIR}/progress"
# 出力オブジェクトキー。CloudFront はこのキーをパスとして配信する。
OUTPUT_KEY = f"videos/{JOB_ID}.mp4"
OUTPUT_KEY_720P = f"videos/{JOB_ID}_720p.mp4"
WATERMARK_ASSET = f"{REPO}/assets/watermark/watermark-60fps.webm"

# GAME に応じたタイトル固有の録画スクリプト(Issue #13でth08を追加)。
# 辞書で明示的に許可した値のみを使うことで、job.game由来のGAME環境変数から
# 任意のパスを組み立てないようにする(値自体はapps/api側でisSupportedGameを
# 通過したものしかジョブ化されないが、念のための防御)。
RECORDING_SCRIPTS = {
    "th07": "record_th07.py",
    "th08": "record_th08.py",
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
    # auto_null sink は起動時に自動生成されるため手動追加しない
    # (追加すると auto_null.2 にリネームされ録画が失敗する, PoC で確認済み)。
    log("pulseaudio を起動します")
    subprocess.run(["pulseaudio", "-D", "--exit-idle-time=-1", "--disallow-exit"], check=False)
    time.sleep(2.0)


def download_replay(s3):
    log(f"リプレイをダウンロード: s3://{REPLAY_BUCKET}/{REPLAY_KEY}")
    s3.download_file(REPLAY_BUCKET, REPLAY_KEY, REPLAY_PATH)


def download_checkpoint_video(s3):
    log(f"生動画をダウンロード(変換から再開): s3://{OUTPUT_BUCKET}/{OUTPUT_KEY}")
    s3.download_file(OUTPUT_BUCKET, OUTPUT_KEY, OUTPUT_VIDEO)


def upload_video(s3, path, key):
    log(f"動画をアップロード: s3://{OUTPUT_BUCKET}/{key}")
    s3.upload_file(
        path, OUTPUT_BUCKET, key,
        ExtraArgs={"ContentType": "video/mp4"},
    )


def record(s3):
    """録画を実行し、完了直後に生動画をS3へチェックポイントとしてアップロードする。"""
    ensure_title_assets(s3, TITLE_ASSETS_BUCKET, GAME, log=log)
    download_replay(s3)
    start_pulseaudio()
    update_status(JOB_ID, "recording")

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
        ]
        if EXPECTED_DURATION_SECONDS:
            cmd += ["--expected-duration-seconds", EXPECTED_DURATION_SECONDS]

        result = subprocess.run(cmd)
    finally:
        progress_reporter.stop()

    if result.returncode != 0 or not os.path.exists(OUTPUT_VIDEO):
        raise RuntimeError(f"録画に失敗しました (exit_code={result.returncode})")

    # 変換前に生動画をチェックポイントとしてアップロードする。以降Spot中断で
    # リトライになっても、次の試行はここから(変換のみ)再開できる。
    upload_video(s3, OUTPUT_VIDEO, OUTPUT_KEY)
    update_status(JOB_ID, "converting", output_path=OUTPUT_KEY)


def convert_and_upload(s3):
    log("720pへアップスケール変換します")
    # 録画フェーズ末尾の進捗値(最大99%)が変換フェーズ開始直後も表示され続けるのを防ぐ。
    update_progress(JOB_ID, 0)

    def on_convert_progress(percent):
        update_progress(JOB_ID, round(percent))

    upscale_to_720p(
        OUTPUT_VIDEO, OUTPUT_VIDEO_720P,
        watermark_path=WATERMARK_ASSET if WATERMARK else None,
        on_progress=on_convert_progress, log=log,
    )
    upload_video(s3, OUTPUT_VIDEO_720P, OUTPUT_KEY_720P)
    update_status(JOB_ID, "done", output_path=OUTPUT_KEY, output_path_720p=OUTPUT_KEY_720P)


def main():
    os.makedirs(WORK_DIR, exist_ok=True)
    s3 = boto3.client("s3")
    log(f"ジョブ開始 job_id={JOB_ID} game={GAME} watermark={WATERMARK}")

    watcher = InterruptionWatcher(on_interruption, log=log)
    watcher.start()

    try:
        job = get_job(JOB_ID)
        resuming = bool(job and job.get("outputPath"))

        if resuming:
            log("生動画チェックポイントを検出しました。変換から再開します")
            download_checkpoint_video(s3)
        else:
            record(s3)

        convert_and_upload(s3)
        log("ジョブ完了")
        watcher.stop()
        notify_task_result(True)
    except Exception as err:  # noqa: BLE001 - 失敗はすべて failed として記録する
        watcher.stop()
        log(f"ERROR: {err}")
        if not _notified.is_set():
            update_status(JOB_ID, "failed", error="録画処理中にエラーが発生しました")
        notify_task_result(False, error_message=str(err))
        sys.exit(1)


if __name__ == "__main__":
    main()
