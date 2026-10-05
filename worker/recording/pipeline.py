"""録画1回ぶんの試行(`attempt_recording`)と、その自動リトライ(`record_with_retry`)。

このモジュールが持つのは**ポーリングの回数・秒数**で、画素比較そのものの閾値は
`recording/vision.py` にある(連続回数は `POLL_INTERVAL_SEC` との積で意味が決まるため、
ループを回すこちら側に置いている)。
"""
import glob
import os
import signal
import subprocess
import time
import traceback
from dataclasses import dataclass

import pulse

from .artifacts import (
    save_diagnostics_snapshot,
    save_progress_snapshot,
    write_cut_result,
    write_desync_result,
    write_timeout_result,
)
from . import sync_marker
from .cut import compute_cut_range, output_video_offset
from .ffmpeg import (
    audio_intermediate_extension,
    build_audio_ffmpeg_cmd,
    build_video_ffmpeg_cmd,
    measure_duplicate_rate,
    mux_audio_video,
)
from .instance import build_injector_cmd, ensure_display, prepare_instance
from .modlog import check_replay_desync, wait_for_log_marker
from .process import attach_thprac, find_live_game_pid, kill_wine_and_wait
from .timing import (
    audio_capture_rate_hz,
    is_speedup,
    recording_time_scale,
    scaled_confirmation_count,
    scaled_poll_count,
    speedup_multiplier,
)
from .vision import (
    END_TEMPLATE_MAD_THRESHOLD,
    STILL_MAD_THRESHOLD,
    build_end_template_mask,
    build_still_mask,
    grab_frame,
    grab_frame_from_video,
    load_end_template,
    mad_masked,
    read_side_stream_frame,
)
from .window import (
    GEOMETRY_SETTLE_TIMEOUT_AFTER_MOVE_SEC,
    find_window,
    wait_for_stable_geometry,
)


# 連続回数はいずれも「等倍録画での秒数」をポーリング回数で表したもの。倍速録画では
# _monitor_until_end() が time_scale 倍して使う(ポーリング間隔は実時間駆動なので、
# 回数を据え置くとゲーム内時間で必要な静止の長さが伸び縮みしてしまう)。
STILL_CONSECUTIVE_REQUIRED = 8  # 8 * POLL_INTERVAL_SEC = 16秒(等倍録画時)
POLL_INTERVAL_SEC = 2.0
POST_START_GRACE_SEC = 15.0
TIMEOUT_SEC = 60 * 60


# テンプレート照合そのものの説明と閾値は `recording/vision.py` にある。
END_TEMPLATE_CONSECUTIVE_REQUIRED = 2  # 2 * POLL_INTERVAL_SEC = 4秒(等倍録画時。倍速録画では
                                       # time_scale 倍されるが、2回より減らさない)。
                                       # 動画圧縮ノイズ等による単発の偶然一致を弾くため連続一致を
                                       # 要求する(reports/34、scaled_confirmation_count())


# 終了検知(画面静止/テンプレート照合)は「連続で一致した」ことを確認するためにこの秒数
# ぶん確定を遅らせており、その間もリプレイ終了後の静止画面(選択画面等)がそのまま録画に
# 残り続ける。リプレイ本編が短いタイトルではこの確認待ちぶんが録画全体に占める割合が
# 無視できず、重複フレーム率チェック(固定で録画開始15〜45秒を見る、Issue #93)の対象窓に
# 静止画面が入り込んで常に閾値を超え、3回とも誤ってリトライ・失敗する
# (本番のth06ncジョブで確認、Issue #250)。`_CONFIRMATION_TAIL_POLL_COUNT_BY_DETECTION_METHOD`は
# detected_byごとの確認待ちポーリング回数で、attempt_recording()が重複フレーム率
# チェック用の実質的なコンテンツ終了秒を逆算するのに使う。
_CONFIRMATION_TAIL_POLL_COUNT_BY_DETECTION_METHOD = {
    "still": (STILL_CONSECUTIVE_REQUIRED, scaled_poll_count),
    "template": (END_TEMPLATE_CONSECUTIVE_REQUIRED, scaled_confirmation_count),
}


# end_templateを使うゲームは終了判定そのものに画面静止を使わない(recording/vision.py)ため、
# デシンク・非再生等で本編が完全に固まった場合にこれを検知する手段が無く、TIMEOUT_SEC
# (60分)まで打ち切られない。処理落ち早期検知(stutter probe)を削除した結果(Issue #193、
# decisions/0038)、こうした完全フリーズは録画開始直後の重複フレーム率チェックに
# 引っかかって破棄・リトライされるだけで、1試行あたり60分を要したままMAX_ATTEMPTS_DEFAULT
# 回繰り返されてしまう。画面が完全に静止したまま5分続いたらタイムアウトと同様に打ち切る
# ことで、1試行あたりの無駄な待ち時間を短縮する。stutter probeが会話シーン等で誤検知した
# 教訓(decisions/0038)を踏まえ、STILL_CONSECUTIVE_REQUIRED(16秒)よりはるかに長い連続
# 静止を要求することで、通常のリプレイ内容(会話イベント等)では届かない値にしてある。
FREEZE_CONSECUTIVE_REQUIRED = 150  # 150 * POLL_INTERVAL_SEC = 300秒(5分、等倍録画時)


# 進捗スクリーンショットの書き出し間隔。POLL_INTERVAL_SEC(2秒)毎に取得している
# フレームのうち5回に1回だけ保存する(=約10秒毎)。既存のMAD差分検知用のffmpeg
# キャプチャを流用するため、追加のffmpeg呼び出しは発生しない。
PROGRESS_SNAPSHOT_EVERY_N_POLLS = 5


# `capture_by_window_id`で録画直前にウィンドウIDを取り直す際のやり直し(計約2秒)。
WINDOW_ID_REFETCH_ATTEMPTS = 10
WINDOW_ID_REFETCH_INTERVAL_SEC = 0.2


MAX_ATTEMPTS_DEFAULT = 3
MAX_DUPLICATE_RATE_DEFAULT = 30.0


# wine.log(injectorのstdout/stderr、_launch_game()参照)にWineが未処理例外を検知した
# 際に出す文字列(Issue #267)。実機再現実験で確認した2パターンいずれにも含まれる:
#   - ゲームプロセスごと消滅する型: "err:seh:NtRaiseException Unhandled exception
#     code c0000005 flags 0 addr 0x..."
#   - AeDebug設定によりwinedbgのクラッシュダイアログが出たままプロセスは生存し続ける型:
#     "wine: Unhandled page fault on write access to ... starting debugger..."
# どちらも「デシンク・正常なリプレイ終了」では出現しない(実機再現実験で確認済み、
# docs/reports/2026-09-19-th15-wine-crash-detection-verification.md)。
#
# この検知が要る理由: 理論尺比(録画時間/リプレイ推定時間)による異常検知は、
# デシンク(回復不能・ユーザーも織り込み済みの東方シリーズ共通の問題)と縮退するため
# 使えない。デシンクをリトライしても直らない上、途中までの動画には価値がある。
# プロセス生存監視・プロセスstate監視・winedbg出現監視は上記2パターンの一方しか
# 検知できないことを実機再現実験で確認しており、wine.logのこの文字列だけが両方を
# 網羅的に検知できる。
WINE_UNHANDLED_EXCEPTION_MARKER = "Unhandled"


def _log_failure_diagnostics(config, log):
    """起動失敗時・ウィンドウ検出失敗時の診断のため、wine.log / mod.log / DXVK log の末尾を出力する。"""
    wine_log = f"{config.instance_dir}/wine.log"
    if os.path.exists(wine_log):
        try:
            with open(wine_log, "r", errors="replace") as f:
                content = f.read()
            if content.strip():
                log(f"--- wine.log (末尾2000文字) ---\n{content[-2000:]}")
        except Exception:
            pass

    if os.path.exists(config.log_path):
        try:
            with open(config.log_path, "r", errors="replace") as f:
                content = f.read()
            if content.strip():
                log(f"--- mod.log (末尾2000文字) ---\n{content[-2000:]}")
        except Exception:
            pass

    # DXVK ログ (th06nc_d3d11.log, th06nc_dxgi.log 等)
    for dxvk_log in glob.glob(f"{config.instance_dir}/*_d3d11.log") + glob.glob(f"{config.instance_dir}/*_dxgi.log"):
        try:
            with open(dxvk_log, "r", errors="replace") as f:
                content = f.read()
            if content.strip():
                log(f"--- {os.path.basename(dxvk_log)} (末尾2000文字) ---\n{content[-2000:]}")
        except Exception:
            pass


def _failure_result(config, env, log, audio=None):
    """game_pid/ウィンドウ検出/安定確認のいずれかが失敗した場合の戻り値。
    output_exists=Falseにしておけばrecord_with_retry()の失敗判定がそのまま効く
    (reports/24で、以前はsys.exit(1)によりリトライループごとプロセスが終了して
    しまう不具合があった教訓を踏まえた設計)。

    `audio`(先に始めていた音声の録音)があれば止める。"""
    if audio is not None:
        _abort_capture(audio)
    _log_failure_diagnostics(config, log)
    kill_wine_and_wait(config, env, config.process_name, log=log)
    return {
        "output_exists": False,
        "classification": "setup_error",
        "total_record_sec": 0.0,
        "time_scale": 1.0,
    }


@dataclass
class _Capture:
    """録画中の ffmpeg プロセス1本ぶんの持ち物(映像・音声で1つずつ作る)。"""

    label: str  # ログに出す表示名("映像" / "音声")
    proc: subprocess.Popen
    target: str  # 出力先の中間ファイル
    log_path: str
    log_file: object


@dataclass
class _EndDetection:
    """終了検知に使う参照画像とマスク。

    **クロップ座標が確定してから、ffmpegを起動する前に組み立てること**。マスクの
    組み立ては純粋な計算だが、ここで例外を出した場合に録画プロセスが起動済みだと
    後片付けの対象から漏れて ffmpeg が取り残される。
    """

    template: object  # load_end_template()の戻り値。Noneなら画面静止のみ判定へフォールバック
    template_mask: object
    template_mad_threshold: float
    still_mask: object


def _abort_capture(capture):
    """録画を中断した試行で、録画中の ffmpeg を止める(出力は使わない)。"""
    capture.proc.terminate()
    try:
        capture.proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        capture.proc.kill()
    capture.log_file.close()


def _start_audio_capture(config, env, output_path, time_scale, log):
    """音声の録音を始め、同期マーカーのトリガーを予約する。

    **映像の録画より先、ゲームの起動直後に始める**。同期マーカー(約3秒のノイズ)を
    MODのメニュー操作が始まる前(タイトル画面の待ち時間中)に鳴らし終え、配信版で
    カットされる区間(リプレイの再生を確定するキーの1秒前より前、`recording/cut.py`)へ
    確実に追い出すため。以前は映像の録画開始の2秒後に鳴らしていたため、メニュー操作の
    速いタイトルではカット後の動画の冒頭にマーカーのノイズが残った。MODはゲームが
    DirectSoundを作るまでトリガーを待つ(`mods/common/dsound_hook.cpp`)。mux時の同期補正は
    壁時計時刻で行うので、音声が映像より先に始まっていても成り立つ(`ffmpeg.mux_audio_video()`)。
    """
    base, _ext = os.path.splitext(output_path)
    audio_target = f"{base}{audio_intermediate_extension(time_scale)}"
    audio_cmd = build_audio_ffmpeg_cmd(config, audio_target, time_scale=time_scale)
    log(f"録画開始(音声・別プロセス): {' '.join(audio_cmd)}")
    audio_log_path = f"{os.path.dirname(output_path)}/ffmpeg_audio.log"
    audio_log_file = open(audio_log_path, "wb")
    audio = _Capture("音声", subprocess.Popen(
        audio_cmd, env=env, stdin=subprocess.PIPE, stdout=audio_log_file, stderr=subprocess.STDOUT,
    ), audio_target, audio_log_path, audio_log_file)
    # 音声ffmpegの録音開始を待ってから、MODに同期マーカーを鳴らさせる(reports/88)。
    sync_marker.schedule_trigger(config, log=log)
    return audio


def _launch_game(config, env, replay_path, log):
    """Xvfb と instance を用意し、injector 経由でゲームを起動して PID を返す。

    検出できなければ None(呼び出し側は `_failure_result()` で後片付けすること)。
    """
    ensure_display(config, env, log=log)
    prepare_instance(config, replay_path, log=log)

    injector_cmd = build_injector_cmd(config)
    log(f"injector を起動します: {' '.join(injector_cmd)}")
    wine_log_path = f"{config.instance_dir}/wine.log"
    wine_log_file = open(wine_log_path, "wb")
    subprocess.Popen(
        injector_cmd,
        cwd=config.instance_dir, env=env,
        stdout=wine_log_file, stderr=subprocess.STDOUT,
    )

    game_pid = None
    t0 = time.time()
    while time.time() - t0 < 20:
        game_pid = find_live_game_pid(config.process_name)
        if game_pid:
            break
        time.sleep(0.1)
    if not game_pid:
        log(f"ERROR: {config.process_name} プロセスが検出できませんでした")
        return None
    log(f"game_pid={game_pid} ({time.time()-t0:.1f}s)")
    return game_pid


def _settle_crop_geometry(config, env, game_pid, seen_lines, log):
    """x11grab に渡すクロップ座標を確定させる。確定できなければ None を返す。

    ウィンドウが見つかった直後の座標を使ってはならない理由と、Xvfb の画面外へ
    はみ出した場合の移動については
    [`docs/decisions/0012`](../../docs/decisions/0012-crop-geometry-after-window-stabilizes.md)。
    """
    geom = None
    t0 = time.time()
    while time.time() - t0 < 20:
        geom = find_window(config, env, game_pid)
        if geom:
            break
        time.sleep(0.1)
    if not geom:
        log("ERROR: ゲームウィンドウが検出できませんでした")
        return None
    log(f"ウィンドウを検出しました: x={geom[0]} y={geom[1]} w={geom[2]} h={geom[3]} "
        f"(winid={geom[4]}。この時点の座標はまだ確定値ではない)")

    # thpracを設定しているタイトル(th20)は、ここで後付けアタッチする。**ウィンドウが
    # 出現した後**なのは、PIDが生えただけの時点ではゲームがまだ`CREATE_SUSPENDED`で、
    # Windows側からは「動いている東方ゲーム」として成立しておらず、thpracがアタッチ先を
    # 見つけられずに終了することがあるため(本番で発生、Issue #110)。それでもMODの
    # タイトルロゴ待ち(th20は10秒)が終わってメニュー操作が始まるまでには
    # 十分間に合う。失敗しても録画は続行する(thprac無しの従来動作に戻るだけ。
    # attach_thprac()参照)。
    attach_thprac(config, env, log=log)

    # ここで得た座標をそのままクロップ座標に使ってはならない。この検出はウィンドウが
    # Xサーバー上でviewableになった直後に成立するが、ゲームによってはその後さらに自分で
    # ウィンドウを再配置する。th11(地霊殿)は openbox の初期配置 client=(159,119)
    # (=800x600に収まるようクランプされた位置)でviewableになった直後に、自身で
    # client=(185,211)(=画面右下にはみ出す位置)へ移動する。実測で両者の間隔は
    # 40msしかなく、負荷の高いEC2上ではこの隙間で検出が成立してしまう
    # (ローカル再現試験でCPUに負荷をかけると8試行中7回発生)。
    # th08は起動から約2.5秒後にウィンドウ自体を破棄・再生成する(座標は同じ(3,29))。
    # そのため、MOD側のWaitForStableWindowが安定を報告するまで待ってから座標を取り直す。
    stable_time = wait_for_log_marker(
        config.log_path, "WaitForStableWindow: stable", timeout=20, poll_interval=0.1,
        log_all=True, seen_lines=seen_lines, log=log,
    )
    if stable_time is None:
        log("ERROR: ウィンドウの安定を確認できませんでした")
        return None
    log("ウィンドウの安定を確認しました。クロップ座標を確定します")

    # MOD側のWaitForStableWindowはHWNDの同一性しか見ておらず(mods/common/window_wait.cpp)、
    # 位置・サイズの安定までは保証しない。座標そのものが落ち着いたことは
    # wait_for_stable_geometry()で別途確認する。
    geom = wait_for_stable_geometry(config, env, game_pid, log=log)
    if not geom:
        log("ERROR: ウィンドウ座標を確定できませんでした")
        return None
    x, y, w, h, winid = geom
    log(f"クロップ座標を確定: x={x} y={y} w={w} h={h} (winid={winid})")

    # 確定した座標がXvfbの画面(config.xvfb_screen)の範囲外にはみ出す場合は左上(0,0)へ移動する
    # (th11の安定位置(185,211)は 185+640=825 > 800 で範囲外。この状態のままだと
    # x11grabが起動に失敗する、touhou-recorder reports/35)。
    # 移動後の実座標は必ず再取得すること: xdotool windowmoveは(装飾のあるウィンドウの場合)
    # ウィンドウ枠を(0,0)へ移動するため、xwininfoが返すクライアント領域のAbsolute
    # upper-leftは(0,0)にならない(th11実機検証で、タイトルバー分ずれて録画される
    # 不具合として発覚、touhou-recorder reports/37)。さらにxdotool windowmoveの反映は
    # 非同期なので、ここでもwait_for_stable_geometry()で座標が落ち着くのを待ってから
    # 画面内に収まったかを判定し、収まるまで最大20回リトライする。
    screen_w, screen_h = (int(v) for v in config.xvfb_screen.split("x")[:2])
    # 負座標(左・上へのはみ出し)も画面外とみなす。従来は右・下へのはみ出し
    # (x + w > screen_w等)しか見ておらず、ウィンドウマネージャが左上の外側
    # (例: x=-3, y=-16)に配置した場合に「画面内に収まっている」と誤判定していた
    # (GPU描画のXorg+nvidia環境で実際に発生、touhou-recorder reports/81 §9.9.5)。
    # 空の録画がそのまま「正常」として通ってしまうため、既存タイトルも含め一般修正する。
    if x < 0 or y < 0 or x + w > screen_w or y + h > screen_h:
        for _ in range(20):
            subprocess.run(["xdotool", "windowmove", winid, "0", "0"], env=env)
            moved_geom = wait_for_stable_geometry(
                config, env, game_pid, log=log,
                timeout=GEOMETRY_SETTLE_TIMEOUT_AFTER_MOVE_SEC,
            )
            if not moved_geom:
                continue
            mx, my, mw, mh, _ = moved_geom
            if mx < 0 or my < 0 or mx + mw > screen_w or my + mh > screen_h:
                continue
            x, y, w, h = mx, my, mw, mh
            break
        else:
            log(f"WARNING: ウィンドウが画面内に収まりませんでした (x={x} y={y} w={w} h={h})")
        log(f"移動後のウィンドウ座標: x={x} y={y} w={w} h={h}")
    else:
        log(f"ウィンドウは既に画面内に収まっているため移動をスキップします: x={x} y={y} w={w} h={h}")
    return x, y, w, h


def _monitor_until_end(config, env, geometry, detection, *, time_scale,
                       progress_dir, expected_duration_seconds, seen_lines, log,
                       side_stream_path=None):
    """リプレイ終了(または異常)を検知するまでポーリングする。

    戻り値: (detected, detected_by, frozen, crashed, last_color_frame, content_end_epoch)。
    **録画の停止はここではやらない**(呼び出し側が `_stop_and_mux()` で止める)。`detected_by`は
    `detected`がTrueだった場合の検知方式("template" / "still")で、呼び出し側がログの
    サマリー行に正しい方式を表示するために使う(未検知/frozen/crashed/timeoutの場合は
    None。以前は`detected`フラグだけを見て`elif detected:`で常に「画面静止検知」に
    固定していたため、テンプレート照合で検知した場合もログのサマリーだけ誤って
    表示されるバグがあった——判定結果(classification)自体は正しかったため実害は表示のみ、
    touhou-recorder reports/76でth06c対応中に発見、th06/07/08/09/10のログ全てに影響)。
    `crashed`はwine.logにWineの未処理例外を検知したか(Issue #267、
    `WINE_UNHANDLED_EXCEPTION_MARKER`参照)。ゲーム画面がフリーズしたまま静止検知が
    誤って「リプレイ終了」と判定してしまう(3182b7c9・d18b4eb3のインシデントで判明、
    docs/reports/2026-09-19-th15-wine-crash-detection-verification.md)ため、静止・
    テンプレート照合より優先してチェックする。
    `last_color_frame`は直近に取得したカラー画像で、試行が破棄された際の診断用証跡
    (Issue #159、`save_diagnostics_snapshot()`)に使う。1回もフレームを取得できないまま
    終了した場合(grace期間中のタイムアウト等)はNone。
    `content_end_epoch`は、終了を確定させた連続一致が**始まった**フレームの壁時計時刻
    (epoch秒)。配信版のカット終了位置(Issue #266)に使う。画面静止なら静止が始まる直前の
    フレーム(=そのフレーム以降は画面が変わっていない)、テンプレート照合なら最初に一致した
    フレームの時刻。`detected`がFalseならNone(カットせず末尾まで残す)。

    時間に関する定数はすべてここで `time_scale` 倍する。ポーリングは実時間駆動
    (`POLL_INTERVAL_SEC`)なので、回数を据え置くと**ゲーム内時間で必要な静止の長さが
    1/time_scale に伸び縮みする**——据え置くと、2倍速で16秒→32秒相当になり
    終了検知が遅れ、スケールの掛け忘れはリプレイ途中の誤検知を招く(しかも classification は "good" に
    なるためリトライされず、途中で切れた動画がそのまま配信される)。
    """
    x, y, w, h = geometry
    post_start_grace_sec = POST_START_GRACE_SEC * time_scale
    timeout_sec = TIMEOUT_SEC * time_scale
    still_consecutive_required = scaled_poll_count(STILL_CONSECUTIVE_REQUIRED, time_scale)
    end_template_consecutive_required = scaled_confirmation_count(
        END_TEMPLATE_CONSECUTIVE_REQUIRED, time_scale,
    )
    freeze_consecutive_required = scaled_poll_count(FREEZE_CONSECUTIVE_REQUIRED, time_scale)
    end_template = detection.template
    end_template_mask = detection.template_mask
    end_template_mad_threshold = detection.template_mad_threshold
    still_mask = detection.still_mask

    # 倍速録画でもタイムアウトは縮めない(th06c/th06ncのメニュー操作は実時間のSleepで待つため)。
    sequence_complete_time = wait_for_log_marker(
        config.log_path, "sequence complete", timeout=20,
        poll_interval=0.1,
        log_all=True, seen_lines=seen_lines, log=log,
    )
    if sequence_complete_time is None:
        log("WARNING: MOD のキーシーケンス完了ログが検出できませんでした")
        sequence_complete_time = time.time()

    gameplay_start = sequence_complete_time
    log(f"リプレイ再生開始とみなす時刻から監視開始(猶予{post_start_grace_sec:.1f}秒)")

    prev_frame = None
    prev_frame_time = None
    last_color_frame = None
    last_side_stream_mtime = None
    consecutive_still = 0
    end_template_consecutive = 0
    consecutive_freeze = 0
    detected = False
    detected_by = None
    content_end_epoch = None
    # 連続一致が始まったフレームの時刻(連続が途切れたらNoneへ戻す)。
    streak_start_time = None
    frozen = False
    crashed = False
    poll_count = 0
    # wine.log(_launch_game()が作成する)の既読バイト数。監視開始時点までの内容
    # (injector起動ログ等)は対象外とし、以降の増分だけを見る。
    wine_log_path = f"{config.instance_dir}/wine.log"
    wine_log_offset = os.path.getsize(wine_log_path) if os.path.exists(wine_log_path) else 0
    while True:
        elapsed = time.time() - gameplay_start
        if elapsed > timeout_sec:
            log(f"TIMEOUT: {timeout_sec:.0f}秒経過したため強制停止します")
            break

        if elapsed < post_start_grace_sec:
            time.sleep(POLL_INTERVAL_SEC)
            continue

        # 画面静止・テンプレート照合より先にチェックする。Wineクラッシュ後は画面が
        # フリーズしたまま静止検知の方が先に成立してしまい、"good"(正常終了)と
        # 誤判定される(3182b7c9・d18b4eb3のインシデントで判明、Issue #267)。
        if os.path.exists(wine_log_path):
            try:
                wine_log_size = os.path.getsize(wine_log_path)
                if wine_log_size > wine_log_offset:
                    with open(wine_log_path, "r", errors="replace") as f:
                        f.seek(wine_log_offset)
                        new_wine_log = f.read()
                    wine_log_offset = wine_log_size
                    if WINE_UNHANDLED_EXCEPTION_MARKER in new_wine_log:
                        log(
                            "ERROR: wine.log にWineの未処理例外を検知しました"
                            "(ゲームプロセスのクラッシュ、Issue #267)。録画を打ち切ります\n"
                            f"--- wine.log 新規出力 ---\n{new_wine_log.strip()}"
                        )
                        crashed = True
                        break
            except OSError:
                # ログファイルの読み取り失敗自体でこの重要度の低い監視を止めない。
                pass

        if side_stream_path:
            # 本番録画用ffmpegが出力しているサブストリームを読む(別プロセスの
            # x11grabを都度起動しない)。フレームがまだ更新されていない/読み込みに
            # 失敗した場合は、今回のポーリングをスキップして直近のフレームのまま
            # 次の周期を待つ(config.poll_side_stream、Issue #241)。
            frame, color_frame, last_side_stream_mtime = read_side_stream_frame(
                side_stream_path, last_side_stream_mtime,
            )
            if frame is None:
                time.sleep(POLL_INTERVAL_SEC)
                continue
            # ffmpegがこのフレームを書き出した時刻。
            frame_time = last_side_stream_mtime
        else:
            frame_time = time.time()
            frame, color_frame = grab_frame(config, env, x, y, w, h)
        last_color_frame = color_frame
        poll_count += 1
        if progress_dir and poll_count % PROGRESS_SNAPSHOT_EVERY_N_POLLS == 0:
            # 進捗は**実時間ではなくコンテンツ秒数**(＝完成品の動画で何秒ぶん進んだか)
            # で報告する。分母の expected_duration_seconds がリプレイの再生時間である
            # 以上、実時間をそのまま入れると倍速録画で進捗率が実際より大きく見えてしまう。
            save_progress_snapshot(
                progress_dir, color_frame, elapsed / time_scale, expected_duration_seconds,
            )
        if config.gpu_display and poll_count % PROGRESS_SNAPSHOT_EVERY_N_POLLS == 0:
            # GPU用インスタンスで実際にGPUが使われているか(wineのwined3d/OpenGLが
            # ホスト側に32bit版NVIDIAライブラリが渡っておらずllvmpipeへ静かに
            # フォールバックしていないか)を録画中を通して確認する軽量ログ(Issue #82、
            # `docs/decisions/0053-mount-32bit-nvidia-client-libraries-for-wine.md`)。
            # utilization.gpuが録画中ずっと0%近辺のままなら、GPUが使われていない
            # 強い兆候(CPU使用率・理論尺比較と合わせて確認すること)。
            try:
                util = subprocess.run(
                    ["nvidia-smi", "--query-gpu=utilization.gpu,utilization.memory,memory.used",
                     "--format=csv,noheader"],
                    env=env, capture_output=True, text=True, timeout=5,
                )
                if util.returncode == 0:
                    log(f"[gpu_util] {util.stdout.strip()}")
                else:
                    # NVMLの初期化失敗(例: "Failed to initialize NVML: Unknown Error")は
                    # stderrではなく**stdout**に出る。stderrだけを記録していたため、
                    # 本番のGPUクラッシュ調査時にこの行が常に空で原因を特定できな
                    # かった(Issue #267)。
                    log(
                        f"[gpu_util] nvidia-smi exit={util.returncode}: "
                        f"stdout={util.stdout.strip()[:200]!r} stderr={util.stderr.strip()[:200]!r}"
                    )
            except Exception as e:
                log(f"[gpu_util] nvidia-smi実行例外: {e}")
        if end_template is not None:
            # テンプレートが使えるゲームでは、画面静止を待たずに毎回テンプレート照合する
            # (静止待ちを挟むと、リプレイ選択画面に戻った後さらにSTILL_CONSECUTIVE_REQUIRED
            # 分の遅延が余分にかかってしまうため、reports/34)。テンプレート自体が
            # ステージクリア画面等の無関係な画面と大きく乖離する(MAD 40〜140超、reports/33・34)
            # ため誤検知リスクは小さいが、動画圧縮ノイズ等による単発の偶然一致を弾くため
            # END_TEMPLATE_CONSECUTIVE_REQUIRED回連続の一致を要求する。
            template_d = mad_masked(frame, end_template, end_template_mask)
            if template_d < end_template_mad_threshold:
                if end_template_consecutive == 0:
                    streak_start_time = frame_time
                end_template_consecutive += 1
            else:
                end_template_consecutive = 0
            log(
                f"poll: elapsed={elapsed:.1f}s template_MAD={template_d:.2f} "
                f"end_template_consecutive={end_template_consecutive}"
            )
            if end_template_consecutive >= end_template_consecutive_required:
                log("リプレイ選択画面と連続して一致したためリプレイ終了と判定しました")
                detected = True
                detected_by = "template"
                content_end_epoch = streak_start_time
                break
            # end_template方式は終了判定に画面静止を使わないため、本編が完全に固まった
            # (デシンク・非再生等)場合を別途検知する必要がある(FREEZE_CONSECUTIVE_REQUIRED
            # 参照)。閾値はSTILL_MAD_THRESHOLDを流用するが、要求する連続回数が16秒相当
            # ではなく5分相当と大幅に長いため、通常のリプレイ内容(会話イベント等)で
            # 誤って打ち切られる心配はない。
            if prev_frame is not None:
                freeze_d = mad_masked(prev_frame, frame, still_mask)
                if freeze_d < STILL_MAD_THRESHOLD:
                    consecutive_freeze += 1
                else:
                    consecutive_freeze = 0
                if consecutive_freeze >= freeze_consecutive_required:
                    log(
                        f"WARNING: 画面が{freeze_consecutive_required * POLL_INTERVAL_SEC / 60:.0f}"
                        "分間静止したままのため強制停止します"
                    )
                    frozen = True
                    break
            prev_frame = frame
        else:
            if prev_frame is not None:
                d = mad_masked(prev_frame, frame, still_mask)
                if d < STILL_MAD_THRESHOLD:
                    if consecutive_still == 0:
                        # 前回のフレームと同じ=静止は前回のフレームの時点で既に始まっている。
                        streak_start_time = prev_frame_time
                    consecutive_still += 1
                else:
                    consecutive_still = 0
                log(f"poll: elapsed={elapsed:.1f}s MAD={d:.2f} still={consecutive_still}")
                if consecutive_still >= still_consecutive_required:
                    log("画面が一定時間変化しなくなったためリプレイ終了と判定しました")
                    detected = True
                    detected_by = "still"
                    content_end_epoch = streak_start_time
                    break
            prev_frame = frame
            prev_frame_time = frame_time
        time.sleep(POLL_INTERVAL_SEC)
    return detected, detected_by, frozen, crashed, last_color_frame, content_end_epoch


def _stop_and_mux(video, audio, output_path, env, log, *, time_scale=1.0, marker_log_path=None):
    """録画を停止し、映像と音声を1本の mp4 へ結合する。成功したら True。

    `marker_log_path`(MODログ)に同期マーカーが記録されていれば、それでA/V同期を補正する
    (`mux_audio_video()`)。"""
    video_proc, audio_proc = video.proc, audio.proc
    video_target, audio_target = video.target, audio.target
    video_log_file, audio_log_file = video.log_file, audio.log_file
    log("録画を停止します (SIGINT)")
    video_proc.send_signal(signal.SIGINT)
    audio_proc.send_signal(signal.SIGINT)
    try:
        video_proc.wait(timeout=20)
    except subprocess.TimeoutExpired:
        log("WARNING: ffmpeg(映像) が時間内に終了しなかったため terminate します")
        video_proc.terminate()
        video_proc.wait(timeout=10)
    video_log_file.close()
    log(f"ffmpeg(映像) exit_code={video_proc.returncode}")
    try:
        audio_proc.wait(timeout=20)
    except subprocess.TimeoutExpired:
        log("WARNING: ffmpeg(音声) が時間内に終了しなかったため terminate します")
        audio_proc.terminate()
        audio_proc.wait(timeout=10)
    audio_log_file.close()
    log(f"ffmpeg(音声) exit_code={audio_proc.returncode}")

    output_exists = False
    if os.path.exists(video_target) and os.path.exists(audio_target):
        output_exists = mux_audio_video(
            video_target, audio_target, output_path, env, log=log,
            time_scale=time_scale, marker_log_path=marker_log_path,
        )
    else:
        log(f"WARNING: 映像/音声の中間ファイルが見つかりません: video={video_target} audio={audio_target}")

    if output_exists:
        log(f"出力ファイル: {output_path} ({os.path.getsize(output_path)} bytes)")
    else:
        # 失敗時の診断のため、ffmpegログの末尾をCloudWatch Logsに残す(ffmpeg.logは
        # ファイルなのでawslogsドライバに拾われず、コンテナ破棄で消えてしまうため)。
        for capture in (video, audio):
            label, path = capture.label, capture.log_path
            try:
                with open(path, "rb") as f:
                    tail = f.read()[-2000:]
                log(f"ffmpeg({label})ログ末尾: {tail.decode(errors='replace')}")
            except OSError:
                pass
    return output_exists


def _start_video_capture(config, env, game_pid, end_template, output_path, *, time_scale,
                         gpu_encode, log):
    """クロップ座標を確定させ、映像の録画を始める。

    戻り値: (seen_lines, geometry, detection, video, side_stream_path)。座標を確定できなければ
    None(呼び出し側は先に始めた音声の録音ごと `_failure_result()` で後片付けすること)。
    """
    # `seen_lines` は MOD ログの既読行。ウィンドウ安定待ちとキーシーケンス完了待ちで
    # 共有し、同じ行を二度ログへ流さないようにする。
    seen_lines = set()
    geometry = _settle_crop_geometry(config, env, game_pid, seen_lines, log)
    if not geometry:
        return None
    x, y, w, h = geometry
    window_id = None
    if config.gpu_display and config.capture_by_window_id:
        # ゲームは起動直後にウィンドウを作り直すことがあり、検出時のIDは録画開始時には
        # 無効になっている(th08で x11grab が "Can't find window" で起動失敗した、
        # touhou-recorder reports/89 §5.3)ため、録画開始の直前に取り直す。作り直しの
        # 瞬間は一時的に見つからないことがあるので、少しだけやり直す。
        fresh = None
        for _ in range(WINDOW_ID_REFETCH_ATTEMPTS):
            fresh = find_window(config, env, game_pid)
            if fresh:
                break
            time.sleep(WINDOW_ID_REFETCH_INTERVAL_SEC)
        if fresh:
            x, y, w, h, window_id = fresh
            geometry = (x, y, w, h)
            log(f"ウィンドウID基準で取り込みます (window_id={window_id})")
        else:
            # 座標基準で続行する(録画自体はできる)。th08のGPU描画ではゲームがウィンドウを
            # 動かすと映像がずれ、終了検知に失敗してタイムアウトになりうる。
            log(
                "WARNING: 録画直前にウィンドウIDを取り直せなかったため、座標基準で取り込みます"
                f"(x={x} y={y})。録画中にウィンドウが動くと映像がずれる可能性があります"
            )
    detection = _EndDetection(
        template=end_template,
        still_mask=build_still_mask(config.still_detect_exclude_rect, w, h),
        template_mask=build_end_template_mask(config.end_template_rect, w, h),
        template_mad_threshold=(
            config.end_template_mad_threshold or END_TEMPLATE_MAD_THRESHOLD),
    )
    log("録画を開始します")

    base, _ext = os.path.splitext(output_path)
    video_target = f"{base}.video.mp4"
    side_stream_path = f"{base}.pollstream.jpg" if config.poll_side_stream else None

    video_cmd = build_video_ffmpeg_cmd(
        config, x, y, w, h, video_target, side_stream_path,
        time_scale=time_scale, gpu_encode=gpu_encode, window_id=window_id,
    )
    log(f"録画開始(映像): {' '.join(video_cmd)}")
    video_log_path = f"{os.path.dirname(output_path)}/ffmpeg_video.log"
    video_log_file = open(video_log_path, "wb")
    video = _Capture("映像", subprocess.Popen(
        video_cmd, env=env, stdin=subprocess.PIPE, stdout=video_log_file, stderr=subprocess.STDOUT,
    ), video_target, video_log_path, video_log_file)
    return seen_lines, geometry, detection, video, side_stream_path


def attempt_recording(config, replay_path, output_path, progress_dir, expected_duration_seconds,
                       diagnostics_dir=None, attempt=1, log=print):
    """録画を1回試行する。戻り値: dict(output_exists, classification, total_record_sec)。
    classification は "good" / "crashed" / "timeout" / "setup_error" のいずれか。
    "crashed" はwine.logにWineの未処理例外を検知した場合(Issue #267、
    `WINE_UNHANDLED_EXCEPTION_MARKER`)で、呼び出し側は常に破棄してリトライする。

    classification が "good" 以外(=この試行が破棄される)なら、直近のフレームを
    診断用証跡として`diagnostics_dir`へ書き出す(Issue #159、`save_diagnostics_snapshot()`)。
    """
    env = config.build_env()
    # 録画速度(倍速録画 Issue #288)のスケール係数。等倍なら1.0で、
    # 時間依存パラメータはすべて従来値のままになる(実際のスケーリングは `_monitor_until_end()`)。
    time_scale = recording_time_scale(env)
    if is_speedup(time_scale):
        log(
            f"倍速録画モード: {speedup_multiplier(time_scale):g}倍速 "
            f"(FPS_LIMIT_TARGET_HZ={env.get('FPS_LIMIT_TARGET_HZ')} "
            f"SPEED_HACK_MULTIPLIER={env.get('SPEED_HACK_MULTIPLIER')}。実時間はゲーム内時間の"
            f"{time_scale:.2f}倍。変換時に等倍へ戻します)"
        )
    # GPU描画(Xorg+nvidia)で録画する場合はNVENCで映像をエンコードする。GPU描画必須
    # タイトル(th06nc/th15)とGPUワーカーで動くタイトル(`with_runtime_overrides()`)が該当。
    gpu_encode = config.gpu_display
    end_template = load_end_template(config.end_template_path)
    if end_template is None:
        log(
            f"WARNING: {config.end_template_path} が見つからないため、画面静止のみで"
            "リプレイ終了を判定します(誤検知の可能性あり、reports/33参照)"
        )

    # 前回の試行のトリガーが残っていると、MODが起動直後(録音開始前)にマーカーを鳴らして
    # しまい検出できなくなる。
    sync_marker.clear_trigger(config)
    game_pid = _launch_game(config, env, replay_path, log)
    if not game_pid:
        return _failure_result(config, env, log)
    audio = _start_audio_capture(config, env, output_path, time_scale, log)

    try:
        started = _start_video_capture(
            config, env, game_pid, end_template, output_path,
            time_scale=time_scale, gpu_encode=gpu_encode, log=log,
        )
    except BaseException:
        # 先に始めた音声の録音を取り残さない(呼び出し側の例外処理はWineしか片付けない)。
        _abort_capture(audio)
        raise
    if started is None:
        return _failure_result(config, env, log, audio=audio)
    seen_lines, geometry, detection, video, side_stream_path = started
    record_start = time.time()

    detected, detected_by, frozen, crashed, last_color_frame, content_end_epoch = _monitor_until_end(
        config, env, geometry, detection, time_scale=time_scale,
        progress_dir=progress_dir, expected_duration_seconds=expected_duration_seconds,
        seen_lines=seen_lines, log=log, side_stream_path=side_stream_path,
    )

    output_exists = _stop_and_mux(
        video, audio, output_path, env, log=log,
        time_scale=time_scale, marker_log_path=config.log_path,
    )

    total_record_sec = time.time() - record_start
    cut = None
    video_offset_sec = 0.0
    if output_exists:
        # 音声の録音は映像より先に始める(`_start_audio_capture()`)ので、mux後の動画では
        # 映像がファイル先頭から数秒〜十数秒後ろにずれて始まる。
        video_offset_sec = output_video_offset(output_path, env) or 0.0
        cut = compute_cut_range(
            config, video.target, output_path, env, time_scale=time_scale,
            content_end_epoch=content_end_epoch, reference_epoch=record_start, log=log,
        )
    if detected:
        classification = "good"
        stop_reason = "リプレイ選択画面テンプレート照合" if detected_by == "template" else "画面静止検知"
    elif crashed:
        # デシンク(理論尺比較と縮退する回復不能な現象)とは異なり、Wineクラッシュは
        # 非決定的でリトライにより解消しうる(同一リプレイの2ジョブが別地点で
        # クラッシュした実例、Issue #267)ため、破棄してリトライする側に倒す
        # (_record_with_retry()側で"crashed"を"good"と区別して常に破棄する)。
        classification = "crashed"
        stop_reason = "Wineクラッシュ検知(wine.log)"
    elif frozen:
        classification = "timeout"
        stop_reason = "画面固着の早期検知(タイムアウト相当)"
    else:
        classification = "timeout"
        stop_reason = "タイムアウト"
    log(f"録画終了。総録画時間 {total_record_sec:.1f}秒 検知方式: {stop_reason}")

    kill_wine_and_wait(config, env, config.process_name, log=log)

    if classification != "good":
        save_diagnostics_snapshot(diagnostics_dir, last_color_frame, attempt, classification)

    # 終了検知の確認待ち(_CONFIRMATION_TAIL_POLL_COUNT_BY_DETECTION_METHOD参照)ぶん
    # total_record_secから差し引いた、リプレイ終了後の静止画面を含まない実質的な
    # コンテンツ終了秒。detected_byが対象外(timeout/frozen)ならtotal_record_secのまま。
    confirmation_tail = _CONFIRMATION_TAIL_POLL_COUNT_BY_DETECTION_METHOD.get(detected_by)
    if confirmation_tail is not None:
        base_count, scale_count = confirmation_tail
        confirmation_tail_sec = scale_count(base_count, time_scale) * POLL_INTERVAL_SEC
        content_end_sec = max(0.0, total_record_sec - confirmation_tail_sec)
    else:
        content_end_sec = total_record_sec

    return {
        "output_exists": output_exists,
        "classification": classification,
        "total_record_sec": total_record_sec,
        "content_end_sec": content_end_sec,
        # mux後の動画で映像が始まる秒数。total_record_sec・content_end_secは映像の録画開始が
        # 起点なので、出力ファイル上の位置へはこれを足して換算する。
        "video_offset_sec": video_offset_sec,
        # 配信版でカットする範囲(Issue #266、`recording/cut.py`)。出力が無ければNone。
        "cut": cut,
        # この試行の録画に適用されていた実時間スケール(等倍なら1.0)。出力は等倍へ
        # 戻す前の生データなので、呼び出し側の診断ログに使う。
        "time_scale": time_scale,
    }


def duplicate_rate_window(content_end_sec):
    """重複フレーム率の検査窓(映像の録画開始からの開始秒, 長さ秒)を返す。短すぎて検査できない
    ならNone。コンテンツ終了が20秒以上なら従来どおり15秒始点。それより短いリプレイ(倍速録画の
    スペルプラクティス等)では15秒始点だと窓が終了後の静止画面に落ちて誤判定するため(Issue #250と
    同種、本番のth06nc 2倍速ジョブで確認)、終端を終了推定の2秒手前に置いて最大10秒遡る。
    始点はメニュー操作・ロード区間を避けて5秒以降。"""
    if content_end_sec >= 20:
        return 15, min(30, content_end_sec - 15)
    end = content_end_sec - 2
    start = max(5, end - 10)
    if end - start < 3:
        return None
    return start, end - start


def record_with_retry(config, replay_path, output_path, *,
                       progress_dir=None, expected_duration_seconds=None, diagnostics_dir=None,
                       max_attempts=MAX_ATTEMPTS_DEFAULT, max_duplicate_rate=MAX_DUPLICATE_RATE_DEFAULT,
                       expected_score=None, desync_result_path=None, timeout_result_path=None,
                       cut_result_path=None, log=print):
    """attempt_recording()を最大max_attempts回試行し、事後の重複フレーム率チェックに
    引っかかった場合は出力を破棄してリトライする。正常な録画が得られればTrueを、
    max_attempts回失敗すればFalseを返す。

    このジョブ専用のPulseAudio null-sink(config.pulse_sink)はここで作成し、成功・失敗を
    問わず戻る際に破棄する(Issue #48)。全試行で同じsinkを使い回す(試行ごとにWineと
    録音ffmpegは起動し直されるため、sinkだけを共有しても前試行の残留ストリームは残らない)。

    expected_score/desync_result_path はリプレイずれの事後検証(Issue #103、
    check_replay_desync()参照)用。録画が成功した時点で1回だけ検証し、
    desync_result_path が指定されていれば結果をJSONへ書き出す。

    timeout_result_path はリプレイ終了を検知できずタイムアウトで打ち切られたか
    (Issue #161)の記録先。desync_result_pathと同様、指定されていれば
    録画成功が確定した時点で結果をJSONへ書き出す。

    diagnostics_dir は試行を破棄した際の最終フレーム(Issue #159)の書き出し先。

    cut_result_path は採用した試行の配信版カット範囲(Issue #266、`recording/cut.py`)の
    書き出し先。
    """
    # 倍速録画ではゲームの音声出力レートに合わせた高レートのsinkを作る(`pulse.create_null_sink()`)。
    sink_rate = audio_capture_rate_hz(recording_time_scale(config.build_env()))
    with pulse.job_sink(config.pulse_sink, rate=sink_rate, log=log):
        return _record_with_retry(
            config, replay_path, output_path,
            progress_dir=progress_dir, expected_duration_seconds=expected_duration_seconds,
            diagnostics_dir=diagnostics_dir,
            max_attempts=max_attempts, max_duplicate_rate=max_duplicate_rate,
            expected_score=expected_score, desync_result_path=desync_result_path,
            timeout_result_path=timeout_result_path, cut_result_path=cut_result_path, log=log,
        )


def _record_with_retry(config, replay_path, output_path, *,
                       progress_dir, expected_duration_seconds, diagnostics_dir,
                       max_attempts, max_duplicate_rate,
                       expected_score, desync_result_path, timeout_result_path,
                       cut_result_path=None, log=print):
    for attempt in range(1, max_attempts + 1):
        log(f"=== 試行 {attempt}/{max_attempts} ===")
        try:
            result = attempt_recording(
                config, replay_path, output_path, progress_dir, expected_duration_seconds,
                diagnostics_dir=diagnostics_dir, attempt=attempt, log=log,
            )
        except Exception as err:  # noqa: BLE001 - この試行の後始末をしてリトライへ倒す
            # attempt_recording()は正常系・setup_error系のどちらの戻り道でも
            # kill_wine_and_wait()を呼んでから返る設計だが、その手前(GameConfig組み立てや
            # ウィンドウ検出等)で想定外の例外が起きると後片付けが一切行われないまま
            # 関数を抜けてしまう。ここで捕まえずに例外を伝播させると、リトライループごと
            # 中断してスクリプト全体がクラッシュし、wineserver/winedeviceがホストに
            # 無期限に取り残される(2026-08-27インシデント)。
            log(f"ERROR: 試行{attempt}中に想定外の例外が発生しました: {err!r}")
            log(traceback.format_exc())
            try:
                kill_wine_and_wait(config, config.build_env(), config.process_name, log=log)
            except Exception as cleanup_err:  # noqa: BLE001 - 後片付け自体の失敗でループを止めない
                log(f"ERROR: 後片付け中にも例外が発生しました: {cleanup_err!r}")
            continue
        if not result["output_exists"]:
            log("WARNING: 出力ファイルが生成されなかったため、この試行は失敗として扱います")
            continue

        if result["classification"] == "crashed":
            # Wineクラッシュはデシンクと異なり非決定的でリトライにより解消しうる
            # (Issue #267)。重複フレーム率チェックを待たず直ちに破棄する
            # (attempt_recording()側で既に診断スナップショットは保存済み)。
            log(f"WARNING: 試行{attempt}中にWineがクラッシュしたため、この試行を破棄してリトライします")
            continue

        # 倍速録画はキャプチャ自体を60N fpsで行うため構造的な重複が無く、閾値は換算しない。
        time_scale = result.get("time_scale", 1.0)
        threshold = max_duplicate_rate
        # total_record_secではなくcontent_end_secを使う。短いリプレイでは終了検知の
        # 確認待ち(_CONFIRMATION_TAIL_POLL_COUNT_BY_DETECTION_METHOD)で録画に付加される
        # 静止画面(選択画面等)が固定30秒窓の大半を占め、閾値超過と誤判定する
        # (本番のth06ncジョブで確認、Issue #250)。
        content_end_sec = result.get("content_end_sec", result["total_record_sec"])
        # 「録画開始15秒」は映像の録画開始が起点。音声を先に録り始めた分(数秒〜十数秒)だけ
        # 出力ファイル上では後ろにずれるので足す。足さないと窓がメニュー操作・ロード区間に
        # かかる(GPUワーカーのth06 4倍速で2.7%→28.6%)。
        video_offset_sec = result.get("video_offset_sec", 0.0)
        window = duplicate_rate_window(content_end_sec)
        if window is None:
            log("コンテンツが短すぎるため重複フレーム率チェックをスキップします")
            dup_rate = None
        else:
            window_start, window_duration = window
            dup_rate = measure_duplicate_rate(output_path, window_start + video_offset_sec, window_duration)
            log(
                f"録画開始{window_start:g}秒以降{window_duration:g}秒の重複フレーム率: {dup_rate}% "
                f"(閾値{threshold:.1f}%、time_scale={time_scale})"
            )
        if dup_rate is not None and dup_rate > threshold:
            log(f"WARNING: 重複フレーム率({dup_rate}%)が閾値({threshold:.1f}%)を超えました。破棄してリトライします")
            # ここでの破棄はattempt_recording()が戻った後に判明するため、ライブキャプチャ
            # (last_color_frame)は使えず、ミュージ済みの出力ファイルから取り直す
            # (Issue #159)。
            save_diagnostics_snapshot(
                diagnostics_dir, grab_frame_from_video(output_path, 15 + video_offset_sec), attempt,
                "duplicate_rate",
            )
            continue

        timed_out = result["classification"] == "timeout"
        if timed_out:
            log(
                "WARNING: リプレイ終了を検知できないままタイムアウトで打ち切られました。"
                "リプレイ終盤が録画されていない可能性があります"
            )
        log(f"試行{attempt}で正常な録画を確認しました")
        desync_detected = check_replay_desync(config, expected_score, log=log)
        write_desync_result(desync_result_path, desync_detected)
        write_timeout_result(timeout_result_path, timed_out)
        write_cut_result(cut_result_path, result.get("cut"))
        return True

    log(f"ERROR: {max_attempts}回試行しても正常な録画が得られませんでした")
    return False
