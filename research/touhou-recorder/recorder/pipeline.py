"""録画1回ぶんの試行(`attempt_recording`)。

このモジュールが持つのは**ポーリングの回数・秒数**で、画素比較そのものの閾値は
`recorder/vision.py`にある(連続回数は`POLL_INTERVAL_SEC`との積で意味が決まるため、
ループを回すこちら側に置いている)。リトライや統計取りは`recorder/runner.py`。

1回の試行は以下の段階を順に進む。各段階は`_`付きのヘルパーに分かれている:

    _launch_game      Xディスプレイ・instanceディレクトリ準備 → injector起動 → PID検出 → thprac
    _settle_geometry  ウィンドウ検出 → 画面内への移動 → クロップ座標の確定
    _build_detection  終了検知に使うテンプレート・マスク・閾値の組み立て
    _start_capture    映像(+音声)ffmpegの起動
    _monitor_until_end  終了検知・処理落ち検知・fps暴走検知のポーリングループ
    _stop_capture     ffmpeg停止 → A/V同期補正付きmux

**後片付けはtry/finallyで保証すること。** 録画処理のどこで例外・タイムアウト・外部
シグナルが発生してもwineserver/winedeviceが放置されないようにしないと、ホストの
system D-Busのメッセージキューを枯渇させシステム全体のハングを引き起こす(reports/55)。
"""
import os
import signal
import subprocess
import time
from dataclasses import dataclass, field

from .chapters import write_stage_chapters
from .ffmpeg import build_audio_ffmpeg_cmd, build_video_ffmpeg_cmd, mux_audio_video
from . import sync_marker
from .instance import (build_injector_cmd, ensure_audio_sink, ensure_display,
                       prepare_instance, remove_audio_sink)
from .log import log
from .modlog import FPS_RUNAWAY_HZ_THRESHOLD, speedup_runaway_threshold, scan_fps_runaway, wait_for_log_marker
from .process import attach_thprac, kill_wine_and_wait, wait_for_game_pid
from .stutter import (
    STUTTER_DUP_FRACTION_THRESHOLD,
    STUTTER_PROBE_ACTIVE_UNTIL_SEC,
    STUTTER_PROBE_PERIOD_SEC,
    probe_stutter,
)
from .timing import MENU_TIME_SCALE, scale_seconds
from .vision import (
    END_TEMPLATE_MAD_THRESHOLD,
    STILL_MAD_THRESHOLD,
    build_end_template_mask,
    build_still_mask,
    grab_frame,
    load_end_template,
    mad_masked,
    read_poll_frame,
    scale_exclude_rects,
)
from .window import find_window, move_into_screen, recheck_origin_before_recording, start_origin_guard, wait_for_window

POLL_INTERVAL_SEC = 2.0
STILL_CONSECUTIVE_REQUIRED = 8  # 8 * POLL_INTERVAL_SEC = 16秒
# リプレイ再生開始から、終了検知・処理落ち検知を始めるまでの猶予。
POST_START_GRACE_SEC = scale_seconds(15.0)
TIMEOUT_SEC = float(os.environ.get("TIMEOUT_SEC", str(40 * 60)))

# フェーズ34: テンプレートが使えるゲームでは画面静止(STILL_CONSECUTIVE_REQUIRED)を待たずに
# 毎回テンプレート照合するため、静止待ちの分だけ終了検知が速くなる。単発の偶然一致(動画
# 圧縮ノイズ等)を弾くため、POLL_INTERVAL_SEC間隔で連続一致することを要求する回数。
END_TEMPLATE_CONSECUTIVE_REQUIRED = 2  # 2 * POLL_INTERVAL_SEC = 4秒

# MODのマーカー待ちに使う基準タイムアウト(低速録画ではMENU_TIME_SCALE倍される)。
MOD_MARKER_TIMEOUT_SEC = 20.0
# ゲームプロセス・ウィンドウの出現待ち。
GAME_PID_TIMEOUT_SEC = 20.0
WINDOW_TIMEOUT_SEC = 20.0
# thpracのアタッチ待ち(reports/72)。
THPRAC_ATTACH_TIMEOUT_SEC = 60.0


@dataclass
class RecordingResult:
    """1回の試行の結果。`runner`はこれを見て破棄・リトライを判断する。"""

    classification: str = "setup_error"  # good / stutter / fps_runaway / timeout / setup_error
    detected: bool = False
    detected_by: str | None = None  # "template" / "still"
    stutter_detected: bool = False
    fps_runaway_hz: float | None = None
    quick_good: bool = False
    total_record_sec: float = 0.0
    stop_reason: str | None = None
    output_exists: bool = False
    # 終了検知に要した「リプレイ本編が終わってから録画停止までの尾部」の長さ。
    # 画面静止検知はSTILL_CONSECUTIVE_REQUIRED回の連続静止を待つのでその分まるごと静止画面が
    # 録画される。テンプレート照合は連続一致のみで止まるのでポーリング間隔+αで済む。
    # 最終的な重複フレーム率の計測からこの尾部を除外しないと、短いリプレイでは計測区間の
    # 大半が静止画面になり「処理落ち」と誤判定される(フェーズ80、21秒のリプレイで39.4%)。
    end_detect_tail_sec: float = 0.0


@dataclass
class _Detection:
    """終了検知・処理落ち検知の判定材料(ウィンドウサイズが確定してから組み立てる)。"""

    end_template: object = None
    end_template_mask: object = None
    end_template_mad_threshold: float = END_TEMPLATE_MAD_THRESHOLD
    still_mask: object = None
    stutter_mask: object = None
    stutter_dup_fraction_threshold: float = STUTTER_DUP_FRACTION_THRESHOLD
    fps_runaway_hz_threshold: float = FPS_RUNAWAY_HZ_THRESHOLD


@dataclass
class _Capture:
    """起動中の録画プロセス一式。"""

    video_proc: object
    video_log_path: str
    video_log_file: object
    record_start: float
    audio_proc: object = None
    audio_log_file: object = None
    poll_raw_path: str | None = None


@dataclass
class _Monitor:
    """ポーリングループの結果。"""

    detected: bool = False
    detected_by: str | None = None
    stutter_detected: bool = False
    fps_runaway_hz: float | None = None
    quick_good: bool = False
    poll_log: list = field(default_factory=list)


def attempt_recording(config, options):
    """1回だけ録画を試みる。プロセスの後片付けまで含めて完結する。"""
    if options.frame_sync:
        # フレーム同期キャプチャは取り込み・時間の数え方・終了検知が別物なので、試行ごと分ける。
        from .framesync import attempt_recording_frame_sync
        return attempt_recording_frame_sync(config, options)
    env = config.build_env()
    try:
        sync_marker.clear_trigger(config)
        game_pid = _launch_game(config, options, env)
        if not game_pid:
            return RecordingResult()

        settled = _settle_geometry(config, env, game_pid)
        if not settled:
            return RecordingResult()
        geometry, winid = settled

        detection = _build_detection(config, geometry)

        seen_lines = set()
        stable_time = wait_for_log_marker(
            config.log_path, "WaitForStableWindow: stable",
            timeout=scale_seconds(MOD_MARKER_TIMEOUT_SEC), poll_interval=0.1,
            log_all=True, seen_lines=seen_lines,
        )
        if stable_time is None:
            log("ERROR: ウィンドウの安定を確認できませんでした")
            return RecordingResult()
        log("ウィンドウの安定を確認しました。録画を開始します(タイトル画面から)")

        if config.gpu_display and not config.skip_origin_move_if_fits:
            geometry = recheck_origin_before_recording(config, env, game_pid, winid, geometry)

        capture_window_id = None
        if config.capture_by_window_id:
            # ゲームは起動直後にウィンドウを作り直すことがあり、検出時のIDは録画開始時には
            # 無効になっている(th08で x11grab が "Can't find window" で起動失敗、reports/89)。
            fresh = find_window(config, env, game_pid)
            if fresh:
                capture_window_id = fresh[4]
                geometry = fresh[:4]
            log(f"ウィンドウID基準で取り込みます (window_id={capture_window_id})")
        capture = _start_capture(config, options, env, geometry, window_id=capture_window_id)
        origin_guard = None
        if (config.gpu_display and not config.skip_origin_move_if_fits
                and not config.capture_by_window_id):
            origin_guard = start_origin_guard(config, env, game_pid, winid)
        if capture.audio_proc is not None:
            # 音声ffmpegの録音開始を待ってから、MODに同期マーカーを鳴らさせる(reports/88)。
            sync_marker.schedule_trigger(config)

        sequence_complete_time = wait_for_log_marker(
            config.log_path, "sequence complete",
            timeout=scale_seconds(MOD_MARKER_TIMEOUT_SEC), poll_interval=0.1,
            log_all=True, seen_lines=seen_lines,
        )
        if sequence_complete_time is None:
            log("WARNING: MODのキーシーケンス完了ログが検出できませんでした")
            sequence_complete_time = time.time()
        log(f"リプレイ再生開始とみなす時刻からの経過監視を開始します(猶予{POST_START_GRACE_SEC}秒)")

        monitor = _monitor_until_end(
            config, options, env, geometry, detection, capture,
            gameplay_start=sequence_complete_time,
        )

        if origin_guard:
            origin_guard.set()
        video_epoch_start = _stop_capture(capture, options, env, config)

        # ステージ開始時刻の書き出し(フェーズ49)。動画のt=0に対応する絶対時刻が取れている
        # 場合のみ行う(取れない場合の推定は誤差要因になるため行わない)。
        write_stage_chapters(config.log_path, options.output, video_epoch_start,
                             time_scale=1.0 / MENU_TIME_SCALE)

        if os.path.exists(options.output):
            log(f"出力ファイルサイズ: {os.path.getsize(options.output)} bytes")
        else:
            log(f"WARNING: 出力ファイルが見つかりません: {options.output}")
            if capture.video_proc.returncode != 0:
                with open(capture.video_log_path, "rb") as f:
                    tail = f.read()[-4000:]
                log(f"ffmpegログ(末尾4000バイト): {tail.decode(errors='replace')}")

        # 終了検知用サブ出力は録画本体には不要なので消す(長尺録画では十数MBになる)。
        if capture.poll_raw_path and os.path.exists(capture.poll_raw_path):
            os.remove(capture.poll_raw_path)

        total_record_sec = time.time() - capture.record_start
        stop_reason, classification = _classify(monitor)
        log(f"録画終了。総録画時間: {total_record_sec:.1f}秒 検知方式: {stop_reason}")
        log(f"poll_log(elapsed_sec, MAD): {monitor.poll_log}")
        log(f"出力ファイル: {options.output}")

        return RecordingResult(
            classification=classification,
            detected=monitor.detected,
            detected_by=monitor.detected_by,
            stutter_detected=monitor.stutter_detected,
            fps_runaway_hz=monitor.fps_runaway_hz,
            quick_good=monitor.quick_good,
            total_record_sec=total_record_sec,
            stop_reason=stop_reason,
            output_exists=os.path.exists(options.output),
            end_detect_tail_sec=(
                POLL_INTERVAL_SEC * END_TEMPLATE_CONSECUTIVE_REQUIRED
                if monitor.detected_by == "template"
                else STILL_CONSECUTIVE_REQUIRED * POLL_INTERVAL_SEC
            ),
        )
    finally:
        # 録画処理本体のどこで例外・タイムアウト・外部シグナルが発生しても
        # wineserver/winedeviceが放置されないことを保証する(reports/55)。
        kill_wine_and_wait(config, env)
        # 倍速録画用のPulseAudioシンクも同じ理由で必ず後片付けする。残すと
        # module-always-sinkがauto_nullを生やさなくなり、以後のネイティブ録画が
        # 音声を録れなくなる(reports/86)。
        remove_audio_sink(config, env)


def _launch_game(config, options, env):
    """Xディスプレイとinstanceディレクトリを用意し、MODを注入してゲームを起動する。

    戻り値はゲームのPID(起動できなければNone)。
    """
    ensure_display(config, env)
    ensure_audio_sink(config, env)
    prepare_instance(config, options.replay, frame_sync=options.frame_sync)

    cmd, dll_args = build_injector_cmd(config)
    log(f"injector を起動します (dlls={dll_args})")
    subprocess.Popen(
        cmd, cwd=config.instance_dir, env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    game_pid, elapsed = wait_for_game_pid(config, timeout=GAME_PID_TIMEOUT_SEC)
    if not game_pid:
        log(f"ERROR: {config.game_exe} プロセスが検出できませんでした")
        return None
    log(f"game_pid={game_pid} ({elapsed:.1f}s)")

    if options.thprac:
        # 低速録画時はfps_limiter_hookのビジーウェイトがCPUを占有し、thprac自体のアタッチ処理
        # (ゲームプロセスへのDLL注入・IPC)も実時間が延びる(th128実機確認、フェーズ72)。
        # ウィンドウ検出等の他の待機と同じ比率でタイムアウトを延長する。
        # 倍速録画では短縮しない(起動処理は実時間で進むため、reports/90)。
        attach_thprac(config, env,
                      timeout=max(THPRAC_ATTACH_TIMEOUT_SEC, scale_seconds(THPRAC_ATTACH_TIMEOUT_SEC)))
    return game_pid


def _settle_geometry(config, env, game_pid):
    """ゲームウィンドウを検出し、録画クロップ座標を確定する。

    戻り値は ((x, y, w, h), window_id)。検出できなければNone。
    """
    # 低速録画時(FPS_LIMIT_TARGET_HZ<60)はfps_limiter_hook系のPresent間引きがCPUを占有し、
    # ウィンドウ安定・入力フック稼働までの実時間が延びることがth09で実機確認された
    # (フェーズ68)ため、他の待機と同じ比率で延長する。倍速録画では短縮しない: ウィンドウの
    # 出現はゲーム内時間ではなく実時間の起動処理で決まり、2倍速で10秒に縮めるとローカル環境の
    # th10で起動が間に合わず失敗した(reports/90)。
    geom = wait_for_window(config, env, game_pid,
                           timeout=max(WINDOW_TIMEOUT_SEC, scale_seconds(WINDOW_TIMEOUT_SEC)))
    if not geom:
        log("ERROR: ゲームウィンドウが検出できませんでした")
        return None
    x, y, w, h, winid = geom
    log(f"ウィンドウ検出: x={x} y={y} w={w} h={h} (winid={winid})")
    geometry = move_into_screen(config, env, game_pid, winid, geom)
    return geometry, winid


def _build_detection(config, geometry):
    """終了検知・処理落ち検知に使うテンプレート・マスク・閾値を、実ウィンドウサイズに
    合わせて組み立てる。"""
    _x, _y, w, h = geometry
    end_template = load_end_template(config.end_template)
    if end_template is None:
        if config.end_template:
            log(f"WARNING: {config.end_template} が見つからないため、画面静止のみでリプレイ終了を"
                "判定します(誤検知の可能性あり、reports/33参照)")
        else:
            log("画面静止のみでリプレイ終了を判定します"
                "(このゲームはend_template未設定。reports/36参照)")

    base = config.exclude_rect_base
    return _Detection(
        end_template=end_template,
        end_template_mask=build_end_template_mask(config.end_template_rect, w, h),
        end_template_mad_threshold=(
            END_TEMPLATE_MAD_THRESHOLD if config.end_template_mad_threshold is None
            else config.end_template_mad_threshold
        ),
        still_mask=build_still_mask(
            scale_exclude_rects(config.still_detect_exclude_rect, base, w, h), w, h),
        # 処理落ち早期検知(probe_stutter)専用のマスク・閾値。未設定のタイトルは従来どおり
        # 全画面MAD・グローバル閾値で判定する(挙動不変)。
        stutter_mask=build_still_mask(
            scale_exclude_rects(config.stutter_probe_exclude_rect, base, w, h), w, h),
        stutter_dup_fraction_threshold=(
            STUTTER_DUP_FRACTION_THRESHOLD if config.stutter_dup_fraction_threshold is None
            else config.stutter_dup_fraction_threshold
        ),
        fps_runaway_hz_threshold=(
            FPS_RUNAWAY_HZ_THRESHOLD if config.fps_runaway_hz_threshold is None
            else speedup_runaway_threshold(config.fps_runaway_hz_threshold)
        ),
    )


def _start_capture(config, options, env, geometry, window_id=None):
    """映像(と、既定では別プロセスの音声)の録画を開始する。"""
    poll_raw_path = None
    # POLL_SIDE_STREAM=0 で従来動作(毎回grab_frame)に戻せる。A/B比較検証用。
    if config.poll_side_stream and os.environ.get("POLL_SIDE_STREAM", "1") != "0":
        poll_raw_path = options.poll_raw_path
        if os.path.exists(poll_raw_path):
            os.remove(poll_raw_path)

    video_cmd = build_video_ffmpeg_cmd(config, options, geometry, poll_raw_path, window_id=window_id)
    log(f"録画開始(映像): {' '.join(video_cmd)}")
    video_log_path = f"{options.output_dir}/ffmpeg.log"
    video_log_file = open(video_log_path, "wb")
    video_proc = subprocess.Popen(
        video_cmd, env=env,
        stdin=subprocess.PIPE, stdout=video_log_file, stderr=subprocess.STDOUT,
    )

    audio_proc = None
    audio_log_file = None
    if options.separate_audio:
        audio_cmd = build_audio_ffmpeg_cmd(config, options)
        log(f"録画開始(音声・別プロセス): {' '.join(audio_cmd)}")
        audio_log_file = open(f"{options.output_dir}/ffmpeg_audio.log", "wb")
        audio_proc = subprocess.Popen(
            audio_cmd, env=env,
            stdin=subprocess.PIPE, stdout=audio_log_file, stderr=subprocess.STDOUT,
        )

    return _Capture(
        video_proc=video_proc,
        video_log_path=video_log_path,
        video_log_file=video_log_file,
        record_start=time.time(),
        audio_proc=audio_proc,
        audio_log_file=audio_log_file,
        poll_raw_path=poll_raw_path,
    )


def _monitor_until_end(config, options, env, geometry, detection, capture, gameplay_start):
    """リプレイ終了(または異常)を検知するまでポーリングし続ける。

    検知の優先順位は「録画プロセスの死 > fps暴走 > 打ち切りモード > 処理落ち > 終了検知」。
    """
    x, y, w, h = geometry
    monitor = _Monitor()
    prev_frame = None
    prev_frame_time = None
    streak_start_time = None
    consecutive_still = 0
    last_poll_frame_index = 0
    end_template_consecutive = 0
    next_stutter_probe = POST_START_GRACE_SEC

    while True:
        elapsed = time.time() - gameplay_start
        if elapsed > TIMEOUT_SEC:
            log(f"TIMEOUT: {TIMEOUT_SEC}秒経過したため強制停止します")
            break

        # 録画用ffmpegが死んでいたら即座に打ち切る。これを見ていないと、x11grabの起動失敗
        # (ウィンドウが画面外にある場合の"Cannot get the image data ... Permission denied"など)に
        # 気づかないままTIMEOUT_SEC(既定40分)まで無言でポーリングし続けることになる
        # (フェーズ81で、ウィンドウ座標が x=-131 になった際に実際に発生した)。
        if capture.video_proc.poll() is not None:
            log(f"ERROR: 録画用ffmpegが終了しています (returncode={capture.video_proc.returncode})。"
                "この試行を中止します")
            with open(capture.video_log_path, "rb") as f:
                tail = f.read()[-1500:]
            log(f"ffmpegログ(末尾): {tail.decode(errors='replace')}")
            break

        runaway_hz = scan_fps_runaway(
            config.log_path, threshold=detection.fps_runaway_hz_threshold)
        if runaway_hz is not None:
            log(f"WARNING: FpsMonitorログで異常な高fps({runaway_hz:.1f}Hz)を検知しました。"
                "fps暴走の疑いがあるため早期終了します")
            monitor.fps_runaway_hz = runaway_hz
            break

        # --record-seconds モード: 検証高速化のため、指定秒数だけ連続録画したら停止する。
        # 画面静止検知・stutter probe・grab_frameは連続録画の重複フレーム率計測を攪乱しうるので、
        # このモードでは一切行わずsleepのみで待つ(fps暴走scanは無害なので残す)。
        if options.record_seconds is not None:
            if elapsed >= options.record_seconds:
                log(f"record-seconds: {options.record_seconds:.0f}秒の録画が完了したため停止します")
                monitor.quick_good = True
                break
            time.sleep(POLL_INTERVAL_SEC)
            continue

        if options.quick_classify_sec is not None and elapsed >= options.quick_classify_sec:
            log(f"quick classify: {options.quick_classify_sec:.0f}秒間異常が検知されなかったため"
                "正常と判定します")
            monitor.quick_good = True
            break

        if elapsed < POST_START_GRACE_SEC:
            time.sleep(POLL_INTERVAL_SEC)
            continue

        # 既に画面静止/テンプレート一致の兆候が出ている(=終了検知フローに入りかけている)
        # 場合はstutter probeを休止する。倍速録画(issue #1)ではプレイ時間自体が
        # STUTTER_PROBE_ACTIVE_UNTIL_SEC(300秒、序盤の外乱検知のみを狙った値)より
        # 短くなるケースがあり、リプレイ終了後の正常な静止画面をprobeが「処理落ち」と
        # 誤検知して早期終了させてしまう不具合が実機検証で見つかった(reports/85)。
        if (elapsed >= next_stutter_probe and elapsed < STUTTER_PROBE_ACTIVE_UNTIL_SEC
                and consecutive_still == 0 and end_template_consecutive == 0):
            dup_fraction = probe_stutter(
                config.display, env, geometry,
                mask=detection.stutter_mask, poll_raw_path=capture.poll_raw_path)
            elapsed_after_probe = time.time() - gameplay_start
            next_stutter_probe = elapsed_after_probe + STUTTER_PROBE_PERIOD_SEC
            log(f"stutter probe: elapsed={elapsed_after_probe:.1f}s dup_fraction={dup_fraction:.2f}")
            if dup_fraction >= detection.stutter_dup_fraction_threshold:
                log(f"WARNING: 短間隔サンプリングでの重複フレーム率({dup_fraction:.2f})が閾値"
                    f"({detection.stutter_dup_fraction_threshold})を超えました。"
                    "処理落ちの疑いがあるため早期終了します")
                monitor.stutter_detected = True
                break
            prev_frame = None

        if capture.poll_raw_path:
            # 録画用ffmpegのサブ出力から読む(別プロセスのx11grabを起こさないので本録画を
            # 妨害しない)。まだ新しいフレームが書かれていない場合はこの周回を見送る
            # (同じフレームを2回読むとMAD=0で静止と誤判定するため)。
            poll_frame_index, frame = read_poll_frame(capture.poll_raw_path)
            if frame is None or poll_frame_index == last_poll_frame_index:
                time.sleep(POLL_INTERVAL_SEC / 4)
                continue
            last_poll_frame_index = poll_frame_index
        else:
            frame = grab_frame(config.display, env, x, y, w, h)
        frame_time = time.time()

        if detection.end_template is not None:
            # テンプレートが使えるゲームでは、画面静止を待たずに毎回テンプレート照合する
            # (静止待ちを挟むと、リプレイ選択画面に戻った後さらにSTILL_CONSECUTIVE_REQUIRED分の
            # 遅延が余分にかかってしまうため。フェーズ34)。テンプレート自体がステージクリア
            # 画面等の無関係な画面と大きく乖離する(MAD 40〜140、reports/33)ため誤検知リスクは
            # 小さいが、動画圧縮ノイズ等による単発の偶然一致を弾くため
            # END_TEMPLATE_CONSECUTIVE_REQUIRED回連続の一致を要求する。
            template_d = mad_masked(frame, detection.end_template, detection.end_template_mask)
            monitor.poll_log.append((round(elapsed, 1), round(template_d, 2)))
            if template_d < detection.end_template_mad_threshold:
                if end_template_consecutive == 0:
                    streak_start_time = frame_time
                end_template_consecutive += 1
            else:
                end_template_consecutive = 0
            log(f"poll: elapsed={elapsed:.1f}s template_MAD={template_d:.2f} "
                f"end_template_consecutive={end_template_consecutive}")
            if end_template_consecutive >= END_TEMPLATE_CONSECUTIVE_REQUIRED:
                log("リプレイ選択画面と連続して一致したため、リプレイ終了と判定しました")
                monitor.detected = True
                monitor.detected_by = "template"
                log(f"content_end_epoch={streak_start_time:.3f}")
                break
        else:
            if prev_frame is not None:
                d = mad_masked(prev_frame, frame, detection.still_mask)
                monitor.poll_log.append((round(elapsed, 1), round(d, 2)))
                if d < STILL_MAD_THRESHOLD:
                    if consecutive_still == 0:
                        # 前回のフレームと同じ=静止は前回のフレームの時点で既に始まっている。
                        streak_start_time = prev_frame_time
                    consecutive_still += 1
                else:
                    consecutive_still = 0
                log(f"poll: elapsed={elapsed:.1f}s MAD={d:.2f} "
                    f"consecutive_still={consecutive_still}")
                if consecutive_still >= STILL_CONSECUTIVE_REQUIRED:
                    log("画面が一定時間変化しなくなったため、リプレイ終了と判定しました")
                    monitor.detected = True
                    monitor.detected_by = "still"
                    log(f"content_end_epoch={streak_start_time:.3f}")
                    break
            prev_frame = frame
            prev_frame_time = frame_time
        time.sleep(POLL_INTERVAL_SEC)

    return monitor


def _stop_capture(capture, options, env, config):
    """録画プロセスをSIGINTで止め、必要ならA/V同期を補正してmuxする。

    戻り値は「mux後の動画のt=0に対応する絶対時刻(epoch秒)」。音声を別プロセスで録った
    場合のみ実測できる(`-copyts`、reports/28)。それ以外はNone。
    """
    log("録画を停止します (SIGINT)")
    capture.video_proc.send_signal(signal.SIGINT)
    if capture.audio_proc is not None:
        capture.audio_proc.send_signal(signal.SIGINT)
    try:
        capture.video_proc.wait(timeout=20)
    except subprocess.TimeoutExpired:
        log("WARNING: ffmpeg(映像) が時間内に終了しなかったため terminate します")
        capture.video_proc.terminate()
        capture.video_proc.wait(timeout=10)
    capture.video_log_file.close()
    log(f"ffmpeg(映像) exit_code={capture.video_proc.returncode}")

    if capture.audio_proc is None:
        return None

    try:
        capture.audio_proc.wait(timeout=20)
    except subprocess.TimeoutExpired:
        log("WARNING: ffmpeg(音声) が時間内に終了しなかったため terminate します")
        capture.audio_proc.terminate()
        capture.audio_proc.wait(timeout=10)
    capture.audio_log_file.close()
    log(f"ffmpeg(音声) exit_code={capture.audio_proc.returncode}")
    return mux_audio_video(options.video_target, options.audio_target, options.output, env,
                           marker_log_path=config.log_path)


def _classify(monitor):
    """ポーリングループの結果を (停止理由, 分類) に落とす。"""
    if monitor.fps_runaway_hz is not None:
        return "fps暴走早期検知", "fps_runaway"
    if monitor.stutter_detected:
        return "処理落ち早期検知", "stutter"
    if monitor.quick_good:
        return "quick classify正常判定", "good"
    if monitor.detected:
        # 検知方式のラベルを両経路で「画面静止検知」と表示していた不具合の修正
        # (フェーズ76。テンプレート照合を使う全タイトルが影響を受けていた)。
        reason = ("リプレイ選択画面テンプレート照合" if monitor.detected_by == "template"
                  else "画面静止検知")
        return reason, "good"
    return "タイムアウト", "timeout"
