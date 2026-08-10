import json
from unittest.mock import MagicMock

import pytest

import convert


def filter_of(cmd):
    return cmd[cmd.index("-filter_complex") + 1]


def test_probe_resolution_parses_ffprobe_json(monkeypatch):
    fake_stdout = json.dumps({"streams": [{"width": 640, "height": 480}]})
    monkeypatch.setattr(
        convert.subprocess, "run", MagicMock(return_value=MagicMock(stdout=fake_stdout))
    )

    assert convert.probe_resolution("input.mp4") == (640, 480)


# --- 配信版の解像度 --------------------------------------------------------


def test_delivery_resolution_keeps_aspect_ratio_for_4_3_input():
    # th07(640x480, 4:3)は1280x720に固定すると横方向だけ引き伸ばされて歪むため、
    # アスペクト比を保った960x720にする(reports/21)。
    assert convert.delivery_resolution(640, 480) == (960, 720)


def test_delivery_resolution_rounds_width_to_even():
    width, _height = convert.delivery_resolution(853, 480)
    assert width % 2 == 0


def test_delivery_resolution_never_downscales_a_960p_recording():
    # th20は1280x960で録画される。高さ720pxへ「合わせる」と960x720への縮小になり、
    # 主要ダウンロード導線がユーザーをわざわざ低い解像度へ誘導してしまう。
    # 720p版が存在する理由(低解像度がYouTubeで60fpsと認識されない、reports/21)は
    # 元から720p以上ある録画には当てはまらない。
    assert convert.delivery_resolution(1280, 960) == (1280, 960)


def test_delivery_resolution_keeps_a_recording_exactly_at_720p():
    assert convert.delivery_resolution(1280, 720) == (1280, 720)


# --- 生データを別途配信するかの判断 ----------------------------------------


def test_separate_raw_output_is_worth_it_only_when_the_resolution_changes():
    # th06/07/08/11の等倍録画: 生データがそのまま元解像度版として通用するので、
    # 無加工でアップロードすれば再エンコードは配信版の1回だけで済む。
    assert convert.needs_separate_raw_output(640, 480) is True


def test_no_separate_raw_output_when_the_resolution_does_not_change():
    # th20の等倍録画: 2本目はウォーターマークの有無しか違わず、S3保管料と
    # CloudFront転送量が倍になるだけ(ウォーターマーク不要ならページAでオフにできる)。
    assert convert.needs_separate_raw_output(1280, 960) is False


def test_no_separate_raw_output_for_a_slow_motion_recording():
    # 低速録画の生データは半分の速度でそのままユーザーへ渡せない。別途出すには
    # 等倍化の再エンコードがもう1回要るのに、得られるのはウォーターマークの
    # 有無しか違わない動画でしかない。
    assert convert.needs_separate_raw_output(640, 480, time_scale=2.0) is False


# --- 1パスに統合されたフィルタグラフ ---------------------------------------


def test_scales_up_a_low_resolution_recording():
    cmd = convert.build_convert_cmd("in.mp4", "out.mp4", width=640, height=480)

    assert "scale=960:720:flags=lanczos" in filter_of(cmd)


def test_does_not_scale_when_the_resolution_already_matches():
    cmd = convert.build_convert_cmd("in.mp4", "out.mp4", width=1280, height=960)

    assert "scale=" not in filter_of(cmd)


def test_compresses_video_pts_and_resamples_audio_for_slow_motion():
    cmd = convert.build_convert_cmd(
        "in.mp4", "out.mp4", width=1280, height=960, time_scale=2.0, audio_sample_rate=48000,
    )
    expr = filter_of(cmd)

    # 映像は尺を半分に圧縮し、音声は倍のサンプルレートで読んでから元へ戻す
    # (遅回しを早回しで戻す可逆変換なので、速度・ピッチとも劣化しない)。
    assert "setpts=0.5*PTS" in expr
    assert "asetrate=96000,aresample=48000" in expr
    assert cmd[cmd.index("-map") + 1] == "[v]"
    assert "[a]" in cmd


def test_forces_the_native_frame_rate_when_undoing_slow_motion():
    """`-r 60` が、30Hz素材を60fpsで撮ったことによる重複フレームを間引く要点。"""
    cmd = convert.build_convert_cmd(
        "in.mp4", "out.mp4", width=1280, height=960, time_scale=2.0, audio_sample_rate=48000,
    )

    assert cmd[cmd.index("-r") + 1] == str(convert.NATIVE_FRAME_RATE_HZ)


def test_does_not_touch_frame_rate_or_audio_for_a_normal_speed_recording():
    cmd = convert.build_convert_cmd("in.mp4", "out.mp4", width=640, height=480)

    assert "-r" not in cmd
    assert "asetrate" not in filter_of(cmd)
    # 音声を触る必要が無ければ再エンコードせずそのまま通す。
    assert cmd[cmd.index("-c:a") + 1] == "copy"
    assert cmd[cmd.index("-map", cmd.index("-map") + 1) + 1] == "0:a"


def test_copies_audio_when_the_sample_rate_cannot_be_probed():
    # 音声トラック無し等。映像だけでも救う(丸ごと失敗させない)。
    cmd = convert.build_convert_cmd(
        "in.mp4", "out.mp4", width=1280, height=960, time_scale=2.0, audio_sample_rate=None,
    )

    assert "asetrate" not in filter_of(cmd)
    assert "setpts=0.5*PTS" in filter_of(cmd)


def test_overlays_the_watermark_in_the_same_pass():
    # ウォーターマークはx11grab録画時ではなくここで合成する。録画時は-copytsで
    # 生ptsがwallclockのまま渡り、overlayのフレーム同期が噛み合わない(本番で発覚)。
    cmd = convert.build_convert_cmd(
        "in.mp4", "out.mp4", width=640, height=480,
        watermark_path="watermark.webm", watermark_width=285,
    )
    expr = filter_of(cmd)

    assert "-copyts" not in cmd
    # VP9アルファはlibvpx経由デコーダでないと不透明扱いになる(reports/18)。
    assert "libvpx-vp9" in cmd
    assert "watermark.webm" in cmd
    assert "scale=960:720:flags=lanczos" in expr
    assert "scale=285:-1" in expr
    assert "overlay=" in expr


def test_undoes_slow_motion_and_overlays_the_watermark_in_one_ffmpeg_invocation():
    """等倍への戻しとウォーターマーク合成が1回の呼び出し・1回のエンコードで済む。"""
    cmd = convert.build_convert_cmd(
        "in.mp4", "out.mp4", width=1280, height=960, time_scale=2.0,
        watermark_path="watermark.webm", audio_sample_rate=48000,
    )
    expr = filter_of(cmd)

    assert cmd.count("ffmpeg") == 1
    assert "setpts=0.5*PTS" in expr
    assert "overlay=" in expr
    assert "asetrate=96000" in expr
    # 出力は1つだけ(＝エンコードも1回だけ)。
    assert cmd.count("libx264") == 1


def test_caps_watermark_width_at_half_the_target_width():
    # 狭いウィンドウでウォーターマークが画面の大半を覆ってしまうのを防ぐ。
    cmd = convert.build_convert_cmd(
        "in.mp4", "out.mp4", width=200, height=480,
        watermark_path="watermark.webm", watermark_width=285,
    )
    target_width, _ = convert.delivery_resolution(200, 480)

    assert f"scale={target_width // 2}:-1" in filter_of(cmd)


# --- 進捗報告・失敗時のログ ------------------------------------------------


def test_reports_progress_in_seconds_at_interval(monkeypatch):
    # progress は全体の長さに対する割合ではなく、実際に処理が完了した秒数を渡す。
    monkeypatch.setattr(convert, "probe_resolution", lambda path: (640, 480))

    clock = {"t": 0.0}

    def fake_monotonic():
        clock["t"] += convert.PROGRESS_REPORT_INTERVAL_SEC + 1
        return clock["t"]

    monkeypatch.setattr(convert.time, "monotonic", fake_monotonic)

    fake_proc = MagicMock()
    fake_proc.stdout = iter(["out_time_ms=5000000\n", "out_time_ms=9500000\n"])
    fake_proc.returncode = 0
    monkeypatch.setattr(convert.subprocess, "Popen", MagicMock(return_value=fake_proc))

    reported = []
    convert.convert_for_delivery("in.mp4", "out.mp4", on_progress=reported.append)

    assert reported == [5.0, 9.5]


def test_raises_on_ffmpeg_failure(monkeypatch):
    monkeypatch.setattr(convert, "probe_resolution", lambda path: (640, 480))
    monkeypatch.setattr(convert.time, "monotonic", lambda: 100.0)

    fake_proc = MagicMock()
    fake_proc.stdout = iter(["out_time_ms=1000000\n"])
    fake_proc.returncode = 1
    monkeypatch.setattr(convert.subprocess, "Popen", MagicMock(return_value=fake_proc))

    with pytest.raises(RuntimeError):
        convert.convert_for_delivery("in.mp4", "out.mp4", on_progress=lambda p: None)


def test_writes_raw_progress_lines_to_ffmpeg_log_path_when_given(tmp_path, monkeypatch):
    # -progress の生出力(frame=/fps=/bitrate=等)をCloudWatchへ全行流すと1ジョブで
    # 数千行に達しノイズになるため(Issue #58フォローアップ)、ファイルへ書き出す。
    monkeypatch.setattr(convert, "probe_resolution", lambda path: (640, 480))
    monkeypatch.setattr(convert.time, "monotonic", lambda: 100.0)

    fake_proc = MagicMock()
    fake_proc.stdout = iter(["frame=10 fps=30\n", "out_time_ms=1000000\n"])
    fake_proc.returncode = 0
    monkeypatch.setattr(convert.subprocess, "Popen", MagicMock(return_value=fake_proc))

    log_path = tmp_path / "ffmpeg_upscale.log"
    logged = []
    convert.convert_for_delivery(
        "in.mp4", "out.mp4", on_progress=lambda p: None,
        log=logged.append, ffmpeg_log_path=str(log_path),
    )

    content = log_path.read_text()
    assert "frame=10 fps=30" in content
    assert "out_time_ms=1000000" in content
    # 正常終了時はCloudWatch側に生ログを残さない(変換内容の1行だけ)。
    assert not any("frame=10" in msg for msg in logged)


def test_tails_ffmpeg_log_to_log_on_failure(tmp_path, monkeypatch):
    monkeypatch.setattr(convert, "probe_resolution", lambda path: (640, 480))
    monkeypatch.setattr(convert.time, "monotonic", lambda: 100.0)

    fake_proc = MagicMock()
    fake_proc.stdout = iter(["Error: something bad happened\n"])
    fake_proc.returncode = 1
    monkeypatch.setattr(convert.subprocess, "Popen", MagicMock(return_value=fake_proc))

    log_path = tmp_path / "ffmpeg_upscale.log"
    logged = []
    with pytest.raises(RuntimeError):
        convert.convert_for_delivery(
            "in.mp4", "out.mp4", on_progress=lambda p: None,
            log=logged.append, ffmpeg_log_path=str(log_path),
        )

    assert any("something bad happened" in msg for msg in logged)


def test_without_ffmpeg_log_path_does_not_write_a_file(monkeypatch, tmp_path):
    monkeypatch.setattr(convert, "probe_resolution", lambda path: (640, 480))
    monkeypatch.setattr(convert.time, "monotonic", lambda: 100.0)
    monkeypatch.chdir(tmp_path)

    fake_proc = MagicMock()
    fake_proc.stdout = iter(["frame=10 fps=30\n", "out_time_ms=1000000\n"])
    fake_proc.returncode = 0
    monkeypatch.setattr(convert.subprocess, "Popen", MagicMock(return_value=fake_proc))

    convert.convert_for_delivery("in.mp4", "out.mp4", on_progress=lambda p: None)

    assert list(tmp_path.iterdir()) == []
