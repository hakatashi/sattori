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


def test_delivery_resolution_scales_a_960p_recording_up_to_1080p():
    # th20は1280x960で録画される。YouTubeは720pと1080pの間の動画を720pへ縮小して
    # 配信するため、1080pへ引き上げる(Issue #284)。
    assert convert.delivery_resolution(1280, 960) == (1440, 1080)


def test_delivery_resolution_keeps_a_recording_exactly_at_720p():
    assert convert.delivery_resolution(1280, 720) == (1280, 720)


def test_delivery_resolution_keeps_a_recording_exactly_at_1080p():
    # th06ncの高解像度録画(1920x1080)。
    assert convert.delivery_resolution(1920, 1080) == (1920, 1080)


def test_delivery_resolution_keeps_a_recording_above_1080p():
    assert convert.delivery_resolution(2560, 1440) == (2560, 1440)


# --- 生データを別途配信するかの判断 ----------------------------------------


def test_separate_raw_output_is_worth_it_only_when_the_resolution_changes():
    # 640x480のタイトルとth20(1280x960、Issue #284で1080pへ引き上げるようになった)の等倍録画。
    assert convert.needs_separate_raw_output(640, 480) is True
    assert convert.needs_separate_raw_output(1280, 960) is True


def test_no_separate_raw_output_when_the_resolution_does_not_change():
    # th06ncの等倍録画: 2本目はウォーターマークの有無しか違わず、S3保管料と
    # CloudFront転送量が倍になるだけ(ウォーターマーク不要ならページAでオフにできる)。
    assert convert.needs_separate_raw_output(1280, 720) is False


def test_no_separate_raw_output_for_a_time_scaled_recording():
    # 等倍でない速度の生データはそのままユーザーへ渡せない。別途出すには
    # 等倍化の再エンコードがもう1回要るのに、得られるのはウォーターマークの
    # 有無しか違わない動画でしかない。
    assert convert.needs_separate_raw_output(640, 480, time_scale=2.0) is False


# --- 1パスに統合されたフィルタグラフ ---------------------------------------


def test_scales_up_a_low_resolution_recording():
    cmd = convert.build_convert_cmd("in.mp4", "out.mp4", width=640, height=480)

    assert "scale=960:720:flags=lanczos" in filter_of(cmd)


def test_does_not_scale_when_the_resolution_already_matches():
    cmd = convert.build_convert_cmd("in.mp4", "out.mp4", width=1280, height=720)

    assert "scale=" not in filter_of(cmd)


def test_compresses_video_pts_and_resamples_audio_for_scale_above_one():
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


def test_forces_the_native_frame_rate_when_undoing_scale_above_one():
    """60fps固定が、30Hz素材を60fpsで撮ったことによる重複フレームを間引く要点。"""
    cmd = convert.build_convert_cmd(
        "in.mp4", "out.mp4", width=1280, height=960, time_scale=2.0, audio_sample_rate=48000,
    )

    assert "setpts=0.5*PTS,fps=60:start_time=0" in filter_of(cmd)


def test_moves_moov_atom_to_the_front_for_streaming_playback():
    # faststart指定が無いとmoov atomが末尾に置かれ、ブラウザでのストリーミング
    # 再生開始時に末尾へのRangeリクエストが追加で発生してしまう(Issue #90)。
    cmd = convert.build_convert_cmd("in.mp4", "out.mp4", width=640, height=480)

    assert cmd[cmd.index("-movflags") + 1] == "+faststart"


def test_does_not_change_speed_for_a_normal_speed_recording():
    cmd = convert.build_convert_cmd("in.mp4", "out.mp4", width=640, height=480)
    expr = filter_of(cmd)

    assert "setpts" not in expr
    assert "asetrate" not in expr
    assert "trim" not in expr


def test_starts_audio_at_zero_with_real_silence():
    """音声の開始が遅い録画をそのまま出すと、MP4の先頭の空編集(elst)になり、
    ブラウザによっては先頭からの再生で無視されて音ズレする(Issue #301)。"""
    cmd = convert.build_convert_cmd("in.mp4", "out.mp4", width=640, height=480)

    assert "[0:a]aresample=first_pts=0[a]" in filter_of(cmd)
    # 無音で埋めるので、等倍録画でも音声は再エンコードする。
    assert cmd[cmd.index("-c:a") + 1] == "aac"


def test_starts_video_at_zero():
    cmd = convert.build_convert_cmd("in.mp4", "out.mp4", width=640, height=480)

    assert "fps=60:start_time=0" in filter_of(cmd)


def test_drops_audio_when_the_sample_rate_cannot_be_probed():
    """音声トラック無し等。映像だけでも救う(丸ごと失敗させない)。

    ここで音声をそのまま通すと、映像だけPTSが半分になった横に2倍の長さの音声が
    残り、冒頭からずれた・尺も倍の動画になる。無音の方が被害が小さい。
    """
    cmd = convert.build_convert_cmd(
        "in.mp4", "out.mp4", width=1280, height=960, time_scale=2.0, audio_sample_rate=None,
    )

    assert "asetrate" not in filter_of(cmd)
    assert "setpts=0.5*PTS" in filter_of(cmd)
    assert "-an" in cmd
    assert "0:a" not in filter_of(cmd)
    assert "-c:a" not in cmd


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


def test_undoes_scale_above_one_and_overlays_the_watermark_in_one_ffmpeg_invocation():
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


# --- リプレイ再生区間外のカット(Issue #266) ---------------------------------


def test_cuts_video_and_audio_to_the_same_range():
    cmd = convert.build_convert_cmd(
        "in.mp4", "out.mp4", width=640, height=480, cut_start=3.25, cut_end=100.5,
    )
    expr = filter_of(cmd)

    assert "[0:v]trim=start=3.250000:end=100.500000,setpts=(PTS-3.250000/TB),fps=60" in expr
    assert "[0:a]aresample=first_pts=0,atrim=start=3.250000:end=100.500000,asetpts=PTS-3.250000/TB[a]" in expr


def test_pads_the_audio_start_before_cutting():
    """録音した音声のptsは先頭からのサンプル数の積算と少しずつずれているので、ptsで切る
    atrimを先に掛けると切り口がずれる(th08の実録画で+26ms)。"""
    cmd = convert.build_convert_cmd("in.mp4", "out.mp4", width=640, height=480, cut_start=3.0)
    expr = filter_of(cmd)

    assert expr.index("aresample=first_pts=0") < expr.index("atrim=")


def test_cuts_before_undoing_the_speedup():
    # カット範囲は録画(等倍へ戻す前)の時間軸の秒数。
    cmd = convert.build_convert_cmd(
        "in.mp4", "out.mp4", width=640, height=480, time_scale=0.5, audio_sample_rate=88200,
        cut_start=2.0, cut_end=50.0,
    )
    expr = filter_of(cmd)

    assert "trim=start=2.000000:end=50.000000,setpts=2.0*(PTS-2.000000/TB),fps=60" in expr
    assert ("[0:a]aresample=first_pts=0,atrim=start=2.000000:end=50.000000,"
            "asetpts=PTS-2.000000/TB,asetrate=44100,aresample=44100[a]") in expr


def test_cuts_only_the_end_when_the_start_is_unknown():
    cmd = convert.build_convert_cmd("in.mp4", "out.mp4", width=640, height=480, cut_end=50.0)
    expr = filter_of(cmd)

    assert "[0:v]trim=end=50.000000,fps=60" in expr
    assert "[0:a]aresample=first_pts=0,atrim=end=50.000000[a]" in expr


# --- 元の解像度版を同時に出す(2本出力) --------------------------------------


def test_writes_the_raw_output_from_the_same_cut_without_scale_or_watermark():
    cmd = convert.build_convert_cmd(
        "in.mp4", "out.mp4", width=640, height=480, cut_start=1.0, cut_end=9.0,
        watermark_path="watermark.webm", raw_output_path="raw.mp4",
    )
    expr = filter_of(cmd)

    assert cmd.count("ffmpeg") == 1
    # カット・フレームレート固定の後で分岐し、拡大とウォーターマークは配信版にだけ掛ける。
    assert "fps=60:start_time=0,split=2[vsrc][vraw];[vsrc]null,scale=960:720" in expr
    assert "asplit=2[a][araw]" in expr
    raw_args = cmd[cmd.index("out.mp4") + 1:]
    assert raw_args[raw_args.index("-map") + 1] == "[vraw]"
    assert "[araw]" in raw_args
    assert raw_args[-1] == "raw.mp4"
    assert cmd.count("libx264") == 2
    assert cmd.count("+faststart") == 2


def test_caps_watermark_width_at_half_the_target_width():
    # 狭いウィンドウでウォーターマークが画面の大半を覆ってしまうのを防ぐ。
    cmd = convert.build_convert_cmd(
        "in.mp4", "out.mp4", width=200, height=480,
        watermark_path="watermark.webm", watermark_width=285,
    )
    target_width, _ = convert.delivery_resolution(200, 480)

    assert f"scale={target_width // 2}:-1" in filter_of(cmd)


# --- poster画像の切り出し(Issue #171) --------------------------------------


def test_probe_duration_parses_ffprobe_output(monkeypatch):
    monkeypatch.setattr(
        convert.subprocess, "run", MagicMock(return_value=MagicMock(stdout="123.45\n"))
    )

    assert convert.probe_duration("in.mp4") == 123.45


def test_probe_duration_returns_none_on_failure(monkeypatch):
    monkeypatch.setattr(
        convert.subprocess, "run", MagicMock(return_value=MagicMock(stdout="N/A\n"))
    )

    assert convert.probe_duration("in.mp4") is None


def test_extracts_a_frame_at_90_percent_by_default(monkeypatch):
    monkeypatch.setattr(convert, "probe_duration", lambda path: 100.0)
    run = MagicMock()
    monkeypatch.setattr(convert.subprocess, "run", run)

    result = convert.extract_poster_frame("in.mp4", "out.jpg")

    assert result is True
    cmd = run.call_args[0][0]
    assert cmd[cmd.index("-ss") + 1] == "90.0"
    assert cmd[cmd.index("-i") + 1] == "in.mp4"
    assert cmd[-1] == "out.jpg"
    assert "-frames:v" in cmd


def test_extract_poster_frame_returns_false_when_duration_unknown(monkeypatch):
    monkeypatch.setattr(convert, "probe_duration", lambda path: None)
    logged = []

    result = convert.extract_poster_frame("in.mp4", "out.jpg", log=logged.append)

    assert result is False
    assert any("スキップ" in msg for msg in logged)


def test_extract_poster_frame_returns_false_on_ffmpeg_failure(monkeypatch):
    monkeypatch.setattr(convert, "probe_duration", lambda path: 100.0)
    monkeypatch.setattr(
        convert.subprocess, "run",
        MagicMock(side_effect=convert.subprocess.CalledProcessError(1, ["ffmpeg"])),
    )
    logged = []

    result = convert.extract_poster_frame("in.mp4", "out.jpg", log=logged.append)

    assert result is False
    assert any("失敗" in msg for msg in logged)


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


# --- 倍速録画(Issue #288) ----------------------------------------------------


def test_no_separate_raw_output_for_a_speedup_recording():
    assert convert.needs_separate_raw_output(640, 480, time_scale=0.5) is False


def test_stretches_video_pts_and_restores_audio_for_speedup():
    # 2倍速: 88200Hzで録った音声を44100Hzとして読み直し(=半分の速度・ピッチ)、
    # 等倍換算のレート(44100Hz)で出す。88200Hzのまま出すと中身に対してファイルだけ大きくなる。
    cmd = convert.build_convert_cmd(
        "in.mp4", "out.mp4", width=640, height=480, time_scale=0.5, audio_sample_rate=88200,
    )
    expr = filter_of(cmd)

    assert "setpts=2.0*PTS,fps=60:start_time=0" in expr
    assert "asetrate=44100,aresample=44100" in expr
    # 先頭の無音は等倍化の前に埋める(無音の長さも一緒に伸縮させるため)。
    assert "[0:a]aresample=first_pts=0,asetrate=44100" in expr


def test_restores_audio_of_a_four_times_speedup_to_the_native_rate():
    cmd = convert.build_convert_cmd(
        "in.mp4", "out.mp4", width=640, height=480, time_scale=0.25, audio_sample_rate=176400,
    )

    assert "asetrate=44100,aresample=44100" in filter_of(cmd)
    assert "setpts=4.0*PTS" in filter_of(cmd)


def test_uses_nvenc_with_constant_quality_when_gpu_encode():
    cmd = convert.build_convert_cmd("in.mp4", "out.mp4", width=640, height=480, gpu_encode=True)

    assert cmd[cmd.index("-c:v", cmd.index("[v]")) + 1] == "h264_nvenc"
    assert cmd[cmd.index("-cq") + 1] == str(convert.NVENC_DELIVERY_CQ)
    # 品質固定(ビットレート上限なし)。配信版のビットレートは内容で4〜13Mbpsと違うため。
    assert cmd[cmd.index("-b:v") + 1] == "0"
    assert "libx264" not in cmd


def test_uses_libx264_by_default():
    cmd = convert.build_convert_cmd("in.mp4", "out.mp4", width=640, height=480)

    assert "libx264" in cmd
    assert "h264_nvenc" not in cmd
