import json
from unittest.mock import MagicMock

import pytest

import upscale


def test_probe_resolution_parses_ffprobe_json(monkeypatch):
    fake_stdout = json.dumps({"streams": [{"width": 640, "height": 480}]})
    monkeypatch.setattr(
        upscale.subprocess, "run", MagicMock(return_value=MagicMock(stdout=fake_stdout))
    )

    assert upscale.probe_resolution("input.mp4") == (640, 480)


def test_upscale_keeps_aspect_ratio_for_4_3_input(monkeypatch):
    # th07(640x480, 4:3)は1280x720に固定すると横方向だけ引き伸ばされて歪むため、
    # アスペクト比を保った960x720になることを確認する(reports/21)。
    monkeypatch.setattr(upscale, "probe_resolution", lambda path: (640, 480))
    run_mock = MagicMock()
    monkeypatch.setattr(upscale.subprocess, "run", run_mock)

    upscale.upscale_to_720p("in.mp4", "out.mp4")

    cmd = run_mock.call_args[0][0]
    assert cmd[cmd.index("-vf") + 1] == "scale=960:720:flags=lanczos"


def test_upscale_without_watermark_uses_simple_vf(monkeypatch):
    monkeypatch.setattr(upscale, "probe_resolution", lambda path: (640, 480))
    run_mock = MagicMock()
    monkeypatch.setattr(upscale.subprocess, "run", run_mock)

    upscale.upscale_to_720p("in.mp4", "out.mp4")

    cmd = run_mock.call_args[0][0]
    assert "-filter_complex" not in cmd
    assert "-vf" in cmd


def test_upscale_with_watermark_overlays_via_filter_complex(monkeypatch):
    # ウォーターマークはx11grab録画時ではなくここ(720p変換、通常のファイル入力
    # 同士)で合成する。-copytsを使わない完成済みファイル入力同士なのでoverlayの
    # フレーム同期が正しく機能する(録画時に合成すると発生していた不具合の修正)。
    monkeypatch.setattr(upscale, "probe_resolution", lambda path: (640, 480))
    run_mock = MagicMock()
    monkeypatch.setattr(upscale.subprocess, "run", run_mock)

    upscale.upscale_to_720p("in.mp4", "out.mp4", watermark_path="watermark.webm", watermark_width=285)

    cmd = run_mock.call_args[0][0]
    assert "-copyts" not in cmd
    assert "libvpx-vp9" in cmd  # VP9アルファはlibvpx経由デコーダでないと不透明扱いになる(reports/18)
    assert "watermark.webm" in cmd
    filter_expr = cmd[cmd.index("-filter_complex") + 1]
    assert "scale=960:720:flags=lanczos" in filter_expr
    assert "scale=285:-1" in filter_expr
    assert "[0:v]" in filter_expr and "[1:v]" in filter_expr
    assert cmd[cmd.index("-map") + 1] == "[v]"
    assert "0:a" in cmd
    assert "libx264" in cmd


def test_upscale_with_watermark_caps_width_at_half_target_width(monkeypatch):
    # ウォーターマーク幅は既定285pxでも、変換後の画面の半分より広くはしない
    # (狭いウィンドウで画面の大半を覆ってしまうのを防ぐ)。
    monkeypatch.setattr(upscale, "probe_resolution", lambda path: (200, 480))
    run_mock = MagicMock()
    monkeypatch.setattr(upscale.subprocess, "run", run_mock)

    upscale.upscale_to_720p("in.mp4", "out.mp4", watermark_path="watermark.webm", watermark_width=285)

    cmd = run_mock.call_args[0][0]
    target_width = round(200 * upscale.TARGET_HEIGHT / 480 / 2) * 2
    filter_expr = cmd[cmd.index("-filter_complex") + 1]
    assert f"scale={target_width // 2}:-1" in filter_expr


def test_upscale_rounds_target_width_to_even(monkeypatch):
    monkeypatch.setattr(upscale, "probe_resolution", lambda path: (853, 480))
    run_mock = MagicMock()
    monkeypatch.setattr(upscale.subprocess, "run", run_mock)

    upscale.upscale_to_720p("in.mp4", "out.mp4")

    cmd = run_mock.call_args[0][0]
    target = cmd[cmd.index("-vf") + 1]
    width = int(target.split("scale=")[1].split(":")[0])
    assert width % 2 == 0


def test_upscale_reports_progress_in_seconds_at_interval(monkeypatch):
    # progress は全体の長さに対する割合ではなく、実際に処理が完了した秒数を渡す。
    monkeypatch.setattr(upscale, "probe_resolution", lambda path: (640, 480))

    clock = {"t": 0.0}

    def fake_monotonic():
        clock["t"] += upscale.PROGRESS_REPORT_INTERVAL_SEC + 1
        return clock["t"]

    monkeypatch.setattr(upscale.time, "monotonic", fake_monotonic)

    fake_proc = MagicMock()
    fake_proc.stdout = iter(
        [
            "out_time_ms=5000000\n",  # 5.0秒処理済み
            "out_time_ms=9500000\n",  # 9.5秒処理済み
        ]
    )
    fake_proc.returncode = 0
    monkeypatch.setattr(upscale.subprocess, "Popen", MagicMock(return_value=fake_proc))

    reported = []
    upscale.upscale_to_720p("in.mp4", "out.mp4", on_progress=reported.append)

    assert reported == [5.0, 9.5]


def test_upscale_raises_on_ffmpeg_failure(monkeypatch):
    monkeypatch.setattr(upscale, "probe_resolution", lambda path: (640, 480))
    monkeypatch.setattr(upscale.time, "monotonic", lambda: 100.0)

    fake_proc = MagicMock()
    fake_proc.stdout = iter(["out_time_ms=1000000\n"])
    fake_proc.returncode = 1
    monkeypatch.setattr(upscale.subprocess, "Popen", MagicMock(return_value=fake_proc))

    with pytest.raises(RuntimeError):
        upscale.upscale_to_720p("in.mp4", "out.mp4", on_progress=lambda p: None)


def test_upscale_writes_raw_progress_lines_to_ffmpeg_log_path_when_given(tmp_path, monkeypatch):
    # -progress の生出力(frame=/fps=/bitrate=等)をCloudWatchへ全行流すと1ジョブで
    # 数千行に達しノイズになるため(Issue #58フォローアップ)、ファイルへ書き出す。
    # 正常終了時はlog()(CloudWatch行き)には何も残さない。
    monkeypatch.setattr(upscale, "probe_resolution", lambda path: (640, 480))
    monkeypatch.setattr(upscale.time, "monotonic", lambda: 100.0)

    fake_proc = MagicMock()
    fake_proc.stdout = iter(["frame=10 fps=30\n", "out_time_ms=1000000\n"])
    fake_proc.returncode = 0
    monkeypatch.setattr(upscale.subprocess, "Popen", MagicMock(return_value=fake_proc))

    log_path = tmp_path / "ffmpeg_upscale.log"
    logged = []
    upscale.upscale_to_720p(
        "in.mp4", "out.mp4", on_progress=lambda p: None,
        log=logged.append, ffmpeg_log_path=str(log_path),
    )

    content = log_path.read_text()
    assert "frame=10 fps=30" in content
    assert "out_time_ms=1000000" in content
    assert logged == []


def test_upscale_tails_ffmpeg_log_to_log_on_failure(tmp_path, monkeypatch):
    monkeypatch.setattr(upscale, "probe_resolution", lambda path: (640, 480))
    monkeypatch.setattr(upscale.time, "monotonic", lambda: 100.0)

    fake_proc = MagicMock()
    fake_proc.stdout = iter(["Error: something bad happened\n"])
    fake_proc.returncode = 1
    monkeypatch.setattr(upscale.subprocess, "Popen", MagicMock(return_value=fake_proc))

    log_path = tmp_path / "ffmpeg_upscale.log"
    logged = []
    with pytest.raises(RuntimeError):
        upscale.upscale_to_720p(
            "in.mp4", "out.mp4", on_progress=lambda p: None,
            log=logged.append, ffmpeg_log_path=str(log_path),
        )

    assert any("something bad happened" in msg for msg in logged)


def test_upscale_without_ffmpeg_log_path_does_not_write_a_file(monkeypatch, tmp_path):
    # 呼び出し側がffmpeg_log_pathを渡さない場合(既存のテスト・ローカル単体実行等)は
    # ファイルへの書き出しを一切行わない。
    monkeypatch.setattr(upscale, "probe_resolution", lambda path: (640, 480))
    monkeypatch.setattr(upscale.time, "monotonic", lambda: 100.0)
    monkeypatch.chdir(tmp_path)

    fake_proc = MagicMock()
    fake_proc.stdout = iter(["frame=10 fps=30\n", "out_time_ms=1000000\n"])
    fake_proc.returncode = 0
    monkeypatch.setattr(upscale.subprocess, "Popen", MagicMock(return_value=fake_proc))

    upscale.upscale_to_720p("in.mp4", "out.mp4", on_progress=lambda p: None)

    assert list(tmp_path.iterdir()) == []
