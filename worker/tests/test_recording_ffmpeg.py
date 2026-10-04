"""録画・結合・計測に使う ffmpeg/ffprobe コマンドの組み立て。"""

import pytest

from recording import ffmpeg
from recording_helpers import make_config


def test_build_video_ffmpeg_cmd_captures_without_watermark():
    # ウォーターマークはmux_audio_video()側で合成するため、build_video_ffmpeg_cmd()は
    # 常にウォーターマークなしの生キャプチャコマンドを返す(-copytsとoverlayの
    # フレーム同期不具合を避けるため、reports/28参照)。
    config = make_config()
    cmd = ffmpeg.build_video_ffmpeg_cmd(config, 0, 0, 640, 480, "out.video.mp4")

    assert cmd[0] == "ffmpeg"
    assert "-filter_complex" not in cmd
    assert "-f" in cmd and "pulse" not in cmd  # 音声は別プロセス(reports/26)
    assert cmd[-1] == "out.video.mp4"
    assert "libx264" in cmd
    assert "640x480" in cmd
    assert "-copyts" in cmd  # A/V同期補正用の絶対start_time保持(reports/28)


def test_build_video_ffmpeg_cmd_with_side_stream_adds_split_filter():
    # Issue #241: poll_side_stream使用時のみsplitフィルタでサブストリーム出力を追加する。
    config = make_config()
    cmd = ffmpeg.build_video_ffmpeg_cmd(config, 0, 0, 1280, 720, "out.video.mp4", "out.pollstream.jpg")

    assert "-filter_complex" in cmd
    assert "split=2" in cmd[cmd.index("-filter_complex") + 1]
    assert "out.video.mp4" in cmd
    assert "out.pollstream.jpg" in cmd
    assert "-update" in cmd
    assert "-flush_packets" in cmd


def test_build_video_ffmpeg_cmd_without_side_stream_matches_legacy_command():
    # side_stream_path未指定時は既存9タイトルのコマンド文字列と完全一致すること
    # (Issue #241対応による回帰が無いことの確認。`-nostdin`はSIGTTIN対策で
    # 2026-09-15に追加した分と、`-thread_queue_size`(Issue #302)の分だけ差分がある、
    # recording/ffmpeg.pyのモジュールdocstring参照)。
    config = make_config()
    legacy = ["ffmpeg", "-y", "-nostdin", "-copyts", "-thread_queue_size", "240",
              "-f", "x11grab", "-draw_mouse", "0", "-video_size", "640x480", "-framerate", "60",
              "-i", f"{config.display}+0,0",
              "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
              "out.video.mp4"]

    assert ffmpeg.build_video_ffmpeg_cmd(config, 0, 0, 640, 480, "out.video.mp4") == legacy
    assert ffmpeg.build_video_ffmpeg_cmd(config, 0, 0, 640, 480, "out.video.mp4", None) == legacy


def test_build_audio_ffmpeg_cmd_uses_pulse_source():
    config = make_config()
    cmd = ffmpeg.build_audio_ffmpeg_cmd(config, "out.audio.m4a")

    assert cmd[0] == "ffmpeg"
    assert "pulse" in cmd
    assert config.pulse_source in cmd
    assert cmd[-1] == "out.audio.m4a"
    assert "-copyts" in cmd  # A/V同期補正用の絶対start_time保持(reports/28)


def test_ffprobe_start_time_parses_ffprobe_output(monkeypatch):
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return type("Result", (), {"stdout": "1784765161.591758\n"})()

    monkeypatch.setattr(ffmpeg.subprocess, "run", fake_run)

    result = ffmpeg.ffprobe_start_time("video.mp4", {})

    assert result == pytest.approx(1784765161.591758)
    assert captured["cmd"][0] == "ffprobe"
    assert "video.mp4" in captured["cmd"]


def test_ffprobe_start_time_returns_none_on_unparsable_output(monkeypatch):
    monkeypatch.setattr(
        ffmpeg.subprocess, "run", lambda cmd, **kwargs: type("Result", (), {"stdout": "N/A\n"})()
    )

    assert ffmpeg.ffprobe_start_time("video.mp4", {}) is None


def test_mux_audio_video_delays_later_starting_audio(monkeypatch):
    monkeypatch.setattr(
        ffmpeg, "ffprobe_start_time",
        lambda path, env: 100.0 if "video" in path else 100.6,
    )
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return type("Result", (), {"returncode": 0, "stderr": b""})()

    monkeypatch.setattr(ffmpeg.subprocess, "run", fake_run)

    ok = ffmpeg.mux_audio_video("video.mp4", "audio.m4a", "out.mp4", {}, log=lambda msg: None)

    assert ok is True
    cmd = captured["cmd"]
    # 音声(audio.m4a)が0.6秒遅く開始したため、mux時にaudio側へ-itsoffsetを与えて補正する
    audio_idx = cmd.index("audio.m4a")
    assert cmd[audio_idx - 3] == "-itsoffset"
    assert float(cmd[audio_idx - 2]) == pytest.approx(0.6)
    video_idx = cmd.index("video.mp4")
    assert cmd[video_idx - 1] != "-itsoffset"


def test_mux_audio_video_delays_later_starting_video(monkeypatch):
    monkeypatch.setattr(
        ffmpeg, "ffprobe_start_time",
        lambda path, env: 100.6 if "video" in path else 100.0,
    )
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return type("Result", (), {"returncode": 0, "stderr": b""})()

    monkeypatch.setattr(ffmpeg.subprocess, "run", fake_run)

    ffmpeg.mux_audio_video("video.mp4", "audio.m4a", "out.mp4", {}, log=lambda msg: None)

    cmd = captured["cmd"]
    video_idx = cmd.index("video.mp4")
    assert cmd[video_idx - 3] == "-itsoffset"
    assert float(cmd[video_idx - 2]) == pytest.approx(0.6)


def test_mux_audio_video_skips_offset_when_start_time_unavailable(monkeypatch):
    monkeypatch.setattr(ffmpeg, "ffprobe_start_time", lambda path, env: None)
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return type("Result", (), {"returncode": 0, "stderr": b""})()

    monkeypatch.setattr(ffmpeg.subprocess, "run", fake_run)

    ffmpeg.mux_audio_video("video.mp4", "audio.m4a", "out.mp4", {}, log=lambda msg: None)

    assert "-itsoffset" not in captured["cmd"]


def test_mux_audio_video_uses_stream_copy(monkeypatch):
    # ウォーターマークはこの関数(録画直後のmux)では合成しない。x11grabの生ptsが
    # wallclockベース(実epoch秒)のまま`-copyts`でfiltergraphに渡ると、ほぼ0起点の
    # ウォーターマーク動画とoverlayのフレーム同期が噛み合わず不発になる不具合が
    # あったため、ウォーターマーク合成はconvert.py側(配信用変換と同時)に移した。
    monkeypatch.setattr(ffmpeg, "ffprobe_start_time", lambda path, env: None)
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return type("Result", (), {"returncode": 0, "stderr": b""})()

    monkeypatch.setattr(ffmpeg.subprocess, "run", fake_run)

    ffmpeg.mux_audio_video("video.mp4", "audio.m4a", "out.mp4", {}, log=lambda msg: None)

    cmd = captured["cmd"]
    assert "-filter_complex" not in cmd
    assert "copy" in cmd


# --- 倍速録画(Issue #288) ----------------------------------------------------


def test_build_video_ffmpeg_cmd_captures_at_the_games_frame_rate_for_speedup():
    """2倍速ではゲームが120fpsで描くので、キャプチャも120fpsにしてvsyncをパススルーにする。"""
    config = make_config()
    cmd = ffmpeg.build_video_ffmpeg_cmd(config, 0, 0, 640, 480, "out.video.mp4", time_scale=0.5)

    assert cmd[cmd.index("-framerate") + 1] == "120"
    # 60fps超でcfr変換させるとタイムスタンプが壊れる(touhou-recorder reports/85)。
    assert cmd[cmd.index("-vsync") + 1] == "0"


def test_build_video_ffmpeg_cmd_queues_capture_frames_while_the_output_is_busy():
    """出力側(NVENCの初期化等)が詰まってもx11grabを止めない(Issue #302)。キューは
    キャプチャのフレームレートで4秒ぶん。入力オプションなので`-i`より前に置く。"""
    config = make_config()
    cmd = ffmpeg.build_video_ffmpeg_cmd(config, 0, 0, 640, 480, "out.video.mp4", time_scale=0.25)

    assert cmd[cmd.index("-thread_queue_size") + 1] == "960"
    assert cmd.index("-thread_queue_size") < cmd.index("-f") < cmd.index("-i")


def test_build_video_ffmpeg_cmd_keeps_60fps_without_vsync_at_native_speed():
    config = make_config()
    cmd = ffmpeg.build_video_ffmpeg_cmd(config, 0, 0, 640, 480, "out.video.mp4")

    assert cmd[cmd.index("-framerate") + 1] == "60"
    assert "-vsync" not in cmd


def test_build_video_ffmpeg_cmd_uses_nvenc_when_gpu_encode():
    config = make_config()
    cmd = ffmpeg.build_video_ffmpeg_cmd(
        config, 0, 0, 640, 480, "out.video.mp4", "out.pollstream.jpg",
        time_scale=0.5, gpu_encode=True,
    )

    assert "h264_nvenc" in cmd
    assert "libx264" not in cmd
    # サイドストリームがあっても、エンコーダ指定は本番出力の側にかかっていること。
    assert cmd.index("h264_nvenc") < cmd.index("out.video.mp4") < cmd.index("out.pollstream.jpg")
    assert cmd.index("-vsync") < cmd.index("out.video.mp4")


def test_build_video_ffmpeg_cmd_captures_by_window_id():
    config = make_config()
    cmd = ffmpeg.build_video_ffmpeg_cmd(config, 3, 29, 640, 480, "out.video.mp4", window_id="0x400001")

    assert cmd[cmd.index("-window_id") + 1] == "0x400001"
    assert cmd[cmd.index("-i") + 1] == config.display  # 座標は付けない


def test_build_audio_ffmpeg_cmd_records_pcm_at_the_scaled_rate_for_speedup():
    """倍速録画の音声はシンクと同じ高レートでPCMのまま録る(AACだと-copytsのstart_timeが壊れる)。"""
    config = make_config()
    cmd = ffmpeg.build_audio_ffmpeg_cmd(config, "out.audio.mov", time_scale=0.5)

    assert cmd[cmd.index("-sample_rate") + 1] == "88200"
    assert cmd[cmd.index("-c:a") + 1] == "pcm_s16le"
    assert ffmpeg.audio_intermediate_extension(0.5) == ".audio.mov"
    assert ffmpeg.audio_intermediate_extension(1.0) == ".audio.m4a"


def test_build_audio_ffmpeg_cmd_is_unchanged_for_normal_speed():
    config = make_config()
    assert ffmpeg.build_audio_ffmpeg_cmd(config, "out.audio.m4a") == [
        "ffmpeg", "-y", "-nostdin", "-copyts", "-f", "pulse", "-i", config.pulse_source,
        "-c:a", "aac", "-b:a", "192k", "out.audio.m4a",
    ]


@pytest.mark.parametrize("scale,expected", [
    (1.0, ["-c:a", "copy"]),
    (2.0, ["-c:a", "copy"]),
    # 2倍速(88200Hz)はAACの範囲内。帯域を録音レートのナイキストまで広げ、ビットレートも倍にする。
    (0.5, ["-c:a", "aac", "-b:a", "384k", "-cutoff", "44100"]),
    # 3倍速以上はAACのサンプルレート上限(96kHz)を超えるので可逆のALAC。
    (1 / 3, ["-c:a", "alac"]),
    (0.25, ["-c:a", "alac"]),
])
def test_audio_encode_args_by_speed(scale, expected):
    assert ffmpeg.audio_encode_args(scale) == expected


def _fake_mux_env(monkeypatch, *, marker, found, residuals):
    """mux_audio_video()の外部呼び出しを差し替え、実行されたmuxコマンドを記録する。"""
    monkeypatch.setattr(
        ffmpeg, "ffprobe_start_time", lambda path, env: 100.0 if "video" in path else 100.6,
    )
    monkeypatch.setattr(ffmpeg.sync_marker, "parse_marker_log", lambda path, log=print: marker)
    monkeypatch.setattr(ffmpeg.sync_marker, "find_marker_time", lambda path, m, env=None: found)
    residual_iter = iter(residuals)
    monkeypatch.setattr(
        ffmpeg.sync_marker, "verify_output",
        lambda path, m, v_start, env=None: (next(residual_iter), 100.0),
    )
    monkeypatch.setattr(ffmpeg.os.path, "exists", lambda path: True)
    cmds = []

    def fake_run(cmd, **kwargs):
        cmds.append(cmd)
        return type("Result", (), {"returncode": 0, "stderr": b""})()

    monkeypatch.setattr(ffmpeg.subprocess, "run", fake_run)
    return cmds


def _audio_offset(cmd):
    audio_idx = cmd.index("audio.mov")
    return float(cmd[audio_idx - 2]) if cmd[audio_idx - 3] == "-itsoffset" else 0.0


def test_mux_audio_video_uses_the_sync_marker_instead_of_start_times(monkeypatch):
    # マーカーは壁時計101.5秒に鳴り、音声ファイル上では0.7秒の位置にあった
    # → 音声の真の先頭は100.8秒(start_timeが示す100.6秒より0.2秒遅い)。
    marker = {"epoch": 101.5, "rate": 88200, "samples": 131072, "seed": 1}
    cmds = _fake_mux_env(monkeypatch, marker=marker, found=(0.7, 150.0), residuals=[0.0])

    ok = ffmpeg.mux_audio_video(
        "video.mp4", "audio.mov", "out.mp4", {}, log=lambda msg: None,
        time_scale=0.5, marker_log_path="/instance/th08_autoplay.log",
    )

    assert ok is True
    assert len(cmds) == 1
    assert _audio_offset(cmds[0]) == pytest.approx(0.8)
    assert cmds[0][cmds[0].index("-c:a") + 1] == "aac"  # 2倍速はmux時にAACへ変換


def test_mux_audio_video_remuxes_once_when_the_residual_is_too_large(monkeypatch):
    marker = {"epoch": 101.5, "rate": 44100, "samples": 131072, "seed": 1}
    cmds = _fake_mux_env(monkeypatch, marker=marker, found=(0.7, 150.0), residuals=[0.010, 0.0])

    ffmpeg.mux_audio_video(
        "video.mp4", "audio.mov", "out.mp4", {}, log=lambda msg: None,
        marker_log_path="/instance/th08_autoplay.log",
    )

    assert len(cmds) == 2
    assert _audio_offset(cmds[1]) == pytest.approx(0.8 - 0.010)


def test_mux_audio_video_falls_back_to_start_times_when_the_marker_is_weak(monkeypatch):
    marker = {"epoch": 101.5, "rate": 44100, "samples": 131072, "seed": 1}
    cmds = _fake_mux_env(monkeypatch, marker=marker, found=(0.7, 5.0), residuals=[])

    ffmpeg.mux_audio_video(
        "video.mp4", "audio.mov", "out.mp4", {}, log=lambda msg: None,
        marker_log_path="/instance/th08_autoplay.log",
    )

    assert len(cmds) == 1
    assert _audio_offset(cmds[0]) == pytest.approx(0.6)
