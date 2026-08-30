"""録画1回ぶんの試行(`attempt_recording`)と、その自動リトライ(`record_with_retry`)。

このモジュールが持つのは**ポーリングの回数・秒数**で、画素比較そのものの閾値は
`recording/vision.py` にある(連続回数は `POLL_INTERVAL_SEC` との積で意味が決まるため、
ループを回すこちら側に置いている)。
"""
import os
import signal
import subprocess
import time
import traceback

import pulse

from .artifacts import save_progress_snapshot, write_desync_result, write_timeout_result
from .ffmpeg import (
    build_audio_ffmpeg_cmd,
    build_video_ffmpeg_cmd,
    measure_duplicate_rate,
    mux_audio_video,
)
from .instance import build_injector_cmd, ensure_xvfb, prepare_instance
from .modlog import check_replay_desync, scan_fps_runaway, wait_for_log_marker
from .process import attach_thprac, find_live_game_pid, kill_wine_and_wait
from .timing import duplicate_rate_threshold_for_raw, scaled_poll_count, slow_motion_scale
from .vision import (
    END_TEMPLATE_MAD_THRESHOLD,
    STILL_MAD_THRESHOLD,
    build_end_template_mask,
    build_still_mask,
    grab_frame,
    load_end_template,
    mad_masked,
)
from .window import (
    GEOMETRY_SETTLE_TIMEOUT_AFTER_MOVE_SEC,
    find_window,
    wait_for_stable_geometry,
)


# 連続回数はいずれも「等倍録画での秒数」をポーリング回数で表したもの。低速録画では
# attempt_recording() が time_scale 倍して使う(ポーリング間隔は実時間駆動なので、
# 回数を据え置くとゲーム内時間で必要な静止の長さが縮んでしまう)。
STILL_CONSECUTIVE_REQUIRED = 8  # 8 * POLL_INTERVAL_SEC = 16秒(等倍録画時)
POLL_INTERVAL_SEC = 2.0
POST_START_GRACE_SEC = 15.0
TIMEOUT_SEC = 60 * 60


END_TEMPLATE_CONSECUTIVE_REQUIRED = 2  # 2 * POLL_INTERVAL_SEC = 4秒(等倍録画時。上記の通り
                                       # 低速録画では time_scale 倍される)。動画圧縮ノイズ等に
                                       # よる単発の偶然一致を弾くため連続一致を要求する(reports/34)


# end_templateを使うゲームは終了判定そのものに画面静止を使わない(上記の通り)ため、
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


MAX_ATTEMPTS_DEFAULT = 3
MAX_DUPLICATE_RATE_DEFAULT = 30.0


def _failure_result(config, env, log):
    """game_pid/ウィンドウ検出/安定確認のいずれかが失敗した場合の戻り値。
    output_exists=Falseにしておけばrecord_with_retry()の失敗判定がそのまま効く
    (reports/24で、以前はsys.exit(1)によりリトライループごとプロセスが終了して
    しまう不具合があった教訓を踏まえた設計)。"""
    kill_wine_and_wait(config, env, config.process_name, log=log)
    return {
        "output_exists": False,
        "classification": "setup_error",
        "fps_runaway_hz": None,
        "total_record_sec": 0.0,
        "time_scale": 1.0,
    }


def attempt_recording(config, replay_path, output_path, progress_dir, expected_duration_seconds, log=print):
    """録画を1回試行する。戻り値: dict(output_exists, classification, fps_runaway_hz, total_record_sec)。
    classification は "good" / "fps_runaway" / "timeout" / "setup_error" のいずれか。
    """
    env = config.build_env()
    # 低速録画(Issue #68)のスケール係数。等倍なら1.0で、以下の時間依存パラメータは
    # すべて従来値のままになる。
    time_scale = slow_motion_scale(env)
    if time_scale != 1.0:
        log(
            f"低速録画モード: FPS_LIMIT_TARGET_HZ={env.get('FPS_LIMIT_TARGET_HZ')} "
            f"(実時間はゲーム内時間の{time_scale:.2f}倍。監視の猶予・タイムアウトも同じ比率で伸ばします)"
        )
    post_start_grace_sec = POST_START_GRACE_SEC * time_scale
    timeout_sec = TIMEOUT_SEC * time_scale
    # 終了検知の「連続回数」も同じ比率で伸ばす。ポーリングは実時間駆動
    # (POLL_INTERVAL_SEC)なので、回数を据え置くと**ゲーム内時間で必要な静止の長さが
    # 1/time_scale に縮む**——低速録画のth20なら16秒→8秒相当になり、会話イベントや
    # 弾幕の薄い区間でリプレイ途中の誤検知を招く(しかも classification は "good" に
    # なるためリトライされず、途中で切れた動画がそのまま配信される)。
    still_consecutive_required = scaled_poll_count(STILL_CONSECUTIVE_REQUIRED, time_scale)
    end_template_consecutive_required = scaled_poll_count(
        END_TEMPLATE_CONSECUTIVE_REQUIRED, time_scale,
    )
    freeze_consecutive_required = scaled_poll_count(FREEZE_CONSECUTIVE_REQUIRED, time_scale)
    end_template = load_end_template(config.end_template_path)
    if end_template is None:
        log(
            f"WARNING: {config.end_template_path} が見つからないため、画面静止のみで"
            "リプレイ終了を判定します(誤検知の可能性あり、reports/33参照)"
        )
    ensure_xvfb(config, env, log=log)
    prepare_instance(config, replay_path, log=log)

    injector_cmd = build_injector_cmd(config)
    log(f"injector を起動します: {' '.join(injector_cmd)}")
    subprocess.Popen(
        injector_cmd,
        cwd=config.instance_dir, env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
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
        return _failure_result(config, env, log)
    log(f"game_pid={game_pid} ({time.time()-t0:.1f}s)")

    geom = None
    t0 = time.time()
    while time.time() - t0 < 20:
        geom = find_window(config, env, game_pid)
        if geom:
            break
        time.sleep(0.1)
    if not geom:
        log("ERROR: ゲームウィンドウが検出できませんでした")
        return _failure_result(config, env, log)
    log(f"ウィンドウを検出しました: x={geom[0]} y={geom[1]} w={geom[2]} h={geom[3]} "
        f"(winid={geom[4]}。この時点の座標はまだ確定値ではない)")

    # thpracを設定しているタイトル(th20)は、ここで後付けアタッチする。**ウィンドウが
    # 出現した後**なのは、PIDが生えただけの時点ではゲームがまだ`CREATE_SUSPENDED`で、
    # Windows側からは「動いている東方ゲーム」として成立しておらず、thpracがアタッチ先を
    # 見つけられずに終了することがあるため(本番で発生、Issue #110)。それでもMODの
    # タイトルロゴ待ち(th20は10秒、低速録画なら20秒)が終わってメニュー操作が始まるまでには
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
    seen_lines = set()
    stable_time = wait_for_log_marker(
        config.log_path, "WaitForStableWindow: stable", timeout=20, poll_interval=0.1,
        log_all=True, seen_lines=seen_lines, log=log,
    )
    if stable_time is None:
        log("ERROR: ウィンドウの安定を確認できませんでした")
        return _failure_result(config, env, log)
    log("ウィンドウの安定を確認しました。クロップ座標を確定します")

    # MOD側のWaitForStableWindowはHWNDの同一性しか見ておらず(mods/common/window_wait.cpp)、
    # 位置・サイズの安定までは保証しない。座標そのものが落ち着いたことは
    # wait_for_stable_geometry()で別途確認する。
    geom = wait_for_stable_geometry(config, env, game_pid, log=log)
    if not geom:
        log("ERROR: ウィンドウ座標を確定できませんでした")
        return _failure_result(config, env, log)
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
    if x + w > screen_w or y + h > screen_h:
        for _ in range(20):
            subprocess.run(["xdotool", "windowmove", winid, "0", "0"], env=env)
            moved_geom = wait_for_stable_geometry(
                config, env, game_pid, log=log,
                timeout=GEOMETRY_SETTLE_TIMEOUT_AFTER_MOVE_SEC,
            )
            if not moved_geom:
                continue
            mx, my, mw, mh, _ = moved_geom
            if mx + mw > screen_w or my + mh > screen_h:
                continue
            x, y, w, h = mx, my, mw, mh
            break
        else:
            log(f"WARNING: ウィンドウが画面内に収まりませんでした (x={x} y={y} w={w} h={h})")
        log(f"移動後のウィンドウ座標: x={x} y={y} w={w} h={h}")
    else:
        log(f"ウィンドウは既に画面内に収まっているため移動をスキップします: x={x} y={y} w={w} h={h}")
    still_mask = build_still_mask(config.still_detect_exclude_rect, w, h)
    end_template_mask = build_end_template_mask(config.end_template_rect, w, h)
    end_template_mad_threshold = config.end_template_mad_threshold or END_TEMPLATE_MAD_THRESHOLD
    log("録画を開始します")

    base, _ext = os.path.splitext(output_path)
    video_target = f"{base}.video.mp4"
    audio_target = f"{base}.audio.m4a"

    video_cmd = build_video_ffmpeg_cmd(config, x, y, w, h, video_target)
    log(f"録画開始(映像): {' '.join(video_cmd)}")
    video_log_path = f"{os.path.dirname(output_path)}/ffmpeg_video.log"
    video_log_file = open(video_log_path, "wb")
    video_proc = subprocess.Popen(
        video_cmd, env=env, stdin=subprocess.PIPE, stdout=video_log_file, stderr=subprocess.STDOUT,
    )

    audio_cmd = build_audio_ffmpeg_cmd(config, audio_target)
    log(f"録画開始(音声・別プロセス): {' '.join(audio_cmd)}")
    audio_log_path = f"{os.path.dirname(output_path)}/ffmpeg_audio.log"
    audio_log_file = open(audio_log_path, "wb")
    audio_proc = subprocess.Popen(
        audio_cmd, env=env, stdin=subprocess.PIPE, stdout=audio_log_file, stderr=subprocess.STDOUT,
    )
    record_start = time.time()

    # MODのメニュー自動操作(dllmain.cppのScaledSleep)は低速録画時に同じ比率だけ
    # 実時間が伸びるため、その完了を待つこちらのタイムアウトも伸ばす。伸ばし忘れると
    # 「シーケンス完了ログが検出できない」と誤判定する(touhou-recorder reports/47)。
    sequence_complete_time = wait_for_log_marker(
        config.log_path, "sequence complete", timeout=20 * time_scale, poll_interval=0.1,
        log_all=True, seen_lines=seen_lines, log=log,
    )
    if sequence_complete_time is None:
        log("WARNING: MOD のキーシーケンス完了ログが検出できませんでした")
        sequence_complete_time = time.time()

    gameplay_start = sequence_complete_time
    log(f"リプレイ再生開始とみなす時刻から監視開始(猶予{post_start_grace_sec:.1f}秒)")

    prev_frame = None
    consecutive_still = 0
    end_template_consecutive = 0
    consecutive_freeze = 0
    detected = False
    frozen = False
    fps_runaway_hz = None
    poll_count = 0
    while True:
        elapsed = time.time() - gameplay_start
        if elapsed > timeout_sec:
            log(f"TIMEOUT: {timeout_sec:.0f}秒経過したため強制停止します")
            break

        runaway_hz = scan_fps_runaway(config.log_path)
        if runaway_hz is not None:
            log(f"WARNING: FpsMonitorログで異常な高fps({runaway_hz:.1f}Hz)を検知しました。早期終了します")
            fps_runaway_hz = runaway_hz
            break

        if elapsed < post_start_grace_sec:
            time.sleep(POLL_INTERVAL_SEC)
            continue

        frame, color_frame = grab_frame(config, env, x, y, w, h)
        poll_count += 1
        if progress_dir and poll_count % PROGRESS_SNAPSHOT_EVERY_N_POLLS == 0:
            # 進捗は**実時間ではなくコンテンツ秒数**(＝完成品の動画で何秒ぶん進んだか)
            # で報告する。分母の expected_duration_seconds がリプレイの再生時間である
            # 以上、低速録画で伸びた実時間をそのまま入れると進捗率が半分に見えてしまう。
            # 実時間が倍かかること自体はフロントエンド側がジョブの `slowMotion` を見て
            # 残り時間の見積もりに織り込む(`apps/web/src/hooks/jobProgressBudget.ts`)。
            save_progress_snapshot(
                progress_dir, color_frame, elapsed / time_scale, expected_duration_seconds,
            )
        if end_template is not None:
            # テンプレートが使えるゲームでは、画面静止を待たずに毎回テンプレート照合する
            # (静止待ちを挟むと、リプレイ選択画面に戻った後さらにSTILL_CONSECUTIVE_REQUIRED
            # 分の遅延が余分にかかってしまうため、reports/34)。テンプレート自体が
            # ステージクリア画面等の無関係な画面と大きく乖離する(MAD 40〜140超、reports/33・34)
            # ため誤検知リスクは小さいが、動画圧縮ノイズ等による単発の偶然一致を弾くため
            # END_TEMPLATE_CONSECUTIVE_REQUIRED回連続の一致を要求する。
            template_d = mad_masked(frame, end_template, end_template_mask)
            if template_d < end_template_mad_threshold:
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
                    consecutive_still += 1
                else:
                    consecutive_still = 0
                log(f"poll: elapsed={elapsed:.1f}s MAD={d:.2f} still={consecutive_still}")
                if consecutive_still >= still_consecutive_required:
                    log("画面が一定時間変化しなくなったためリプレイ終了と判定しました")
                    detected = True
                    break
            prev_frame = frame
        time.sleep(POLL_INTERVAL_SEC)

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
        output_exists = mux_audio_video(video_target, audio_target, output_path, env, log=log)
    else:
        log(f"WARNING: 映像/音声の中間ファイルが見つかりません: video={video_target} audio={audio_target}")

    if output_exists:
        log(f"出力ファイル: {output_path} ({os.path.getsize(output_path)} bytes)")
    else:
        # 失敗時の診断のため、ffmpegログの末尾をCloudWatch Logsに残す(ffmpeg.logは
        # ファイルなのでawslogsドライバに拾われず、コンテナ破棄で消えてしまうため)。
        for label, path in (("映像", video_log_path), ("音声", audio_log_path)):
            try:
                with open(path, "rb") as f:
                    tail = f.read()[-2000:]
                log(f"ffmpeg({label})ログ末尾: {tail.decode(errors='replace')}")
            except OSError:
                pass

    total_record_sec = time.time() - record_start
    if fps_runaway_hz is not None:
        classification = "fps_runaway"
        stop_reason = "fps暴走早期検知"
    elif detected:
        classification = "good"
        stop_reason = "画面静止検知"
    elif frozen:
        classification = "timeout"
        stop_reason = "画面固着の早期検知(タイムアウト相当)"
    else:
        classification = "timeout"
        stop_reason = "タイムアウト"
    log(f"録画終了。総録画時間 {total_record_sec:.1f}秒 検知方式: {stop_reason}")

    kill_wine_and_wait(config, env, config.process_name, log=log)

    return {
        "output_exists": output_exists,
        "classification": classification,
        "fps_runaway_hz": fps_runaway_hz,
        "total_record_sec": total_record_sec,
        # この試行の録画に適用されていた実時間スケール(等倍なら1.0)。出力は等倍へ
        # 戻す前の生データなので、重複フレーム率の判定にこの値が要る
        # (`duplicate_rate_threshold_for_raw()`)。
        "time_scale": time_scale,
    }


def record_with_retry(config, replay_path, output_path, *,
                       progress_dir=None, expected_duration_seconds=None,
                       max_attempts=MAX_ATTEMPTS_DEFAULT, max_duplicate_rate=MAX_DUPLICATE_RATE_DEFAULT,
                       expected_score=None, desync_result_path=None, timeout_result_path=None,
                       log=print):
    """attempt_recording()を最大max_attempts回試行し、fps暴走・処理落ちの早期検知や
    事後の重複フレーム率チェックに引っかかった場合は出力を破棄してリトライする。
    正常な録画が得られればTrueを、max_attempts回失敗すればFalseを返す。

    このジョブ専用のPulseAudio null-sink(config.pulse_sink)はここで作成し、成功・失敗を
    問わず戻る際に破棄する(Issue #48)。全試行で同じsinkを使い回す(試行ごとにWineと
    録音ffmpegは起動し直されるため、sinkだけを共有しても前試行の残留ストリームは残らない)。

    expected_score/desync_result_path はリプレイずれの事後検証(Issue #103、
    check_replay_desync()参照)用。録画が成功した時点で1回だけ検証し、
    desync_result_path が指定されていれば結果をJSONへ書き出す。

    timeout_result_path はリプレイ終了を検知できずタイムアウトで打ち切られたか
    (Issue #161)の記録先。desync_result_pathと同様、指定されていれば
    録画成功が確定した時点で結果をJSONへ書き出す。
    """
    with pulse.job_sink(config.pulse_sink, log=log):
        return _record_with_retry(
            config, replay_path, output_path,
            progress_dir=progress_dir, expected_duration_seconds=expected_duration_seconds,
            max_attempts=max_attempts, max_duplicate_rate=max_duplicate_rate,
            expected_score=expected_score, desync_result_path=desync_result_path,
            timeout_result_path=timeout_result_path, log=log,
        )


def _record_with_retry(config, replay_path, output_path, *,
                       progress_dir, expected_duration_seconds,
                       max_attempts, max_duplicate_rate,
                       expected_score, desync_result_path, timeout_result_path, log):
    for attempt in range(1, max_attempts + 1):
        log(f"=== 試行 {attempt}/{max_attempts} ===")
        try:
            result = attempt_recording(
                config, replay_path, output_path, progress_dir, expected_duration_seconds, log=log,
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
        if result["classification"] == "fps_runaway":
            log(f"WARNING: fps暴走({result['fps_runaway_hz']:.1f}Hz)を検知したため破棄してリトライします")
            continue

        # 判定対象は**等倍へ戻す前の生データ**なので、閾値の方をスケールに合わせて
        # 換算する(`duplicate_rate_threshold_for_raw()`)。等倍録画では換算しても
        # 値が変わらないため、th06/07/08/11の挙動は従来どおり。
        time_scale = result.get("time_scale", 1.0)
        threshold = duplicate_rate_threshold_for_raw(max_duplicate_rate, time_scale)
        dup_rate = measure_duplicate_rate(output_path, 15, min(30, max(5, result["total_record_sec"] - 15)))
        log(
            f"録画開始15秒以降の重複フレーム率: {dup_rate}% "
            f"(閾値{threshold:.1f}% = 等倍換算{max_duplicate_rate}%、time_scale={time_scale})"
        )
        if dup_rate is not None and dup_rate > threshold:
            log(f"WARNING: 重複フレーム率({dup_rate}%)が閾値({threshold:.1f}%)を超えました。破棄してリトライします")
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
        return True

    log(f"ERROR: {max_attempts}回試行しても正常な録画が得られませんでした")
    return False
