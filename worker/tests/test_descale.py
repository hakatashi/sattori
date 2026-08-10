"""低速録画(Issue #68)の等倍変換のテスト。

ffmpeg/ffprobe の実行自体は差し替え、組み立てたコマンドと戻り値の約束だけを検証する
(実際の変換結果の正しさは touhou-recorder reports/47 の実機検証が根拠)。
"""
import subprocess

import pytest

import descale


class FakeCompleted:
    def __init__(self, returncode=0, stdout="", stderr=b""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


@pytest.fixture
def fake_ffmpeg(monkeypatch, tmp_path):
    """ffprobe には固定のサンプルレートを、ffmpeg には成功と出力ファイル生成を返させる。"""
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        if cmd[0] == "ffprobe":
            return FakeCompleted(stdout="48000\n")
        # ffmpeg の出力先は常にコマンド末尾。
        with open(cmd[-1], "wb") as f:
            f.write(b"video")
        return FakeCompleted(returncode=0)

    monkeypatch.setattr(descale.subprocess, "run", fake_run)
    return calls


def test_returns_false_without_running_anything_at_normal_speed(monkeypatch, tmp_path):
    """等倍録画では呼ばれない想定だが、呼ばれても何もせず False を返す。"""
    def explode(*a, **k):
        raise AssertionError("等倍では ffmpeg を起動してはいけない")

    monkeypatch.setattr(descale.subprocess, "run", explode)

    assert descale.descale_to_normal_speed("in.mp4", "out.mp4", 1.0) is False


def test_compresses_video_pts_and_resamples_audio_by_the_same_ratio(fake_ffmpeg, tmp_path):
    out = str(tmp_path / "out.mp4")

    assert descale.descale_to_normal_speed("in.mp4", out, 2.0, log=lambda _m: None) is True

    ffmpeg_cmd = fake_ffmpeg[-1]
    filter_complex = ffmpeg_cmd[ffmpeg_cmd.index("-filter_complex") + 1]
    # 映像は尺を半分に圧縮し、音声は倍のサンプルレートで読んでから元のレートへ戻す
    # (遅回しを早回しで戻す可逆変換なので、速度・ピッチとも劣化しない)。
    assert "setpts=0.5*PTS" in filter_complex
    assert "asetrate=96000" in filter_complex
    assert "aresample=48000" in filter_complex


def test_forces_the_native_frame_rate_so_duplicate_frames_are_decimated(fake_ffmpeg, tmp_path):
    """`-r 60` が、30Hz素材を60fpsで撮ったことによる重複フレームを間引く要点。

    これがあるおかげで、後段の重複フレーム率チェックを等倍録画と同じ閾値のまま
    使える(descale.py のモジュール docstring 参照)。
    """
    out = str(tmp_path / "out.mp4")

    descale.descale_to_normal_speed("in.mp4", out, 2.0, native_hz=60.0, log=lambda _m: None)

    ffmpeg_cmd = fake_ffmpeg[-1]
    assert ffmpeg_cmd[ffmpeg_cmd.index("-r") + 1] == "60.0"


def test_converts_video_only_when_the_audio_stream_cannot_be_probed(monkeypatch, tmp_path):
    def fake_run(cmd, **kwargs):
        if cmd[0] == "ffprobe":
            return FakeCompleted(stdout="")  # サンプルレートが読めない
        with open(cmd[-1], "wb") as f:
            f.write(b"video")
        return FakeCompleted(returncode=0)

    monkeypatch.setattr(descale.subprocess, "run", fake_run)
    out = str(tmp_path / "out.mp4")
    logs = []

    assert descale.descale_to_normal_speed("in.mp4", out, 2.0, log=logs.append) is True
    assert any("映像のみ" in m for m in logs)


def test_returns_false_and_logs_the_tail_when_ffmpeg_fails(monkeypatch, tmp_path):
    def fake_run(cmd, **kwargs):
        if cmd[0] == "ffprobe":
            return FakeCompleted(stdout="48000\n")
        return FakeCompleted(returncode=1, stderr=b"Invalid data found")

    monkeypatch.setattr(descale.subprocess, "run", fake_run)
    logs = []

    # 例外ではなく False を返す。呼び出し元(attempt_recording)が「この試行は失敗」と
    # して既存のリトライ経路にそのまま乗せられるようにするため。
    assert (
        descale.descale_to_normal_speed("in.mp4", str(tmp_path / "out.mp4"), 2.0, log=logs.append)
        is False
    )
    assert any("Invalid data found" in m for m in logs)


def test_returns_false_when_ffmpeg_succeeds_but_produces_nothing(monkeypatch, tmp_path):
    def fake_run(cmd, **kwargs):
        if cmd[0] == "ffprobe":
            return FakeCompleted(stdout="48000\n")
        return FakeCompleted(returncode=0)  # 出力ファイルを作らない

    monkeypatch.setattr(descale.subprocess, "run", fake_run)

    assert (
        descale.descale_to_normal_speed(
            "in.mp4", str(tmp_path / "out.mp4"), 2.0, log=lambda _m: None
        )
        is False
    )


def test_probe_returns_none_instead_of_raising_when_ffprobe_is_missing(monkeypatch):
    def explode(*a, **k):
        raise OSError("ffprobe not found")

    monkeypatch.setattr(descale.subprocess, "run", explode)

    assert descale._probe_audio_sample_rate("in.mp4") is None


def test_probe_returns_none_on_ffprobe_timeout(monkeypatch):
    def timeout(*a, **k):
        raise subprocess.TimeoutExpired("ffprobe", 30)

    monkeypatch.setattr(descale.subprocess, "run", timeout)

    assert descale._probe_audio_sample_rate("in.mp4") is None
