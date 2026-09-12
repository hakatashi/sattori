"""GPU描画(Xorg+NVIDIA GRIDドライバ)によるヘッドレス画面の初期化(Issue #241)。"""

import subprocess

from recording import gpu_display
from recording_helpers import make_config


def test_query_bus_id_returns_value_via_subprocess(monkeypatch):
    def fake_run(cmd, **kwargs):
        assert cmd == ["nvidia-xconfig", "--query-gpu-info"]
        return subprocess.CompletedProcess(
            cmd, returncode=0,
            stdout="GPU #0:\n  PCI BusID : PCI:49:0:0\n", stderr="",
        )

    monkeypatch.setattr(gpu_display.subprocess, "run", fake_run)

    assert gpu_display._query_bus_id({}) == "PCI:49:0:0"


def test_query_bus_id_returns_none_when_not_found(monkeypatch):
    monkeypatch.setattr(
        gpu_display.subprocess, "run",
        lambda cmd, **k: subprocess.CompletedProcess(cmd, returncode=0, stdout="no info\n", stderr=""),
    )

    assert gpu_display._query_bus_id({}) is None


def test_primary_output_name_parses_xrandr_query(monkeypatch):
    xrandr_output = (
        "Screen 0: minimum 8 x 8, current 2200 x 1400, maximum 30720 x 17280\n"
        "DVI-D-0 connected primary 1024x768+588+316 (normal left inverted right x axis y axis) 0mm x 0mm\n"
    )
    monkeypatch.setattr(
        gpu_display.subprocess, "run",
        lambda cmd, **k: subprocess.CompletedProcess(cmd, returncode=0, stdout=xrandr_output, stderr=""),
    )

    assert gpu_display._primary_output_name({}) == "DVI-D-0"


def test_primary_output_name_returns_none_when_no_output_connected(monkeypatch):
    monkeypatch.setattr(
        gpu_display.subprocess, "run",
        lambda cmd, **k: subprocess.CompletedProcess(cmd, returncode=0, stdout="Screen 0:\n", stderr=""),
    )

    assert gpu_display._primary_output_name({}) is None


def test_ensure_gpu_display_reuses_existing_display(monkeypatch):
    calls = []
    monkeypatch.setattr(
        gpu_display.subprocess, "run",
        lambda cmd, **k: (calls.append(list(cmd)), subprocess.CompletedProcess(cmd, returncode=0))[1],
    )
    config = make_config(gpu_display=True, display=":88")

    gpu_display.ensure_gpu_display(config, {}, log=lambda _m: None)

    # xdotool searchだけが呼ばれ、Xorg等は一切起動しない
    assert calls == [["xdotool", "search", "--name", "."]]


def test_ensure_gpu_display_raises_when_bus_id_unresolvable(monkeypatch):
    def fake_run(cmd, **kwargs):
        if cmd[0] == "xdotool":
            return subprocess.CompletedProcess(cmd, returncode=1)
        return subprocess.CompletedProcess(cmd, returncode=0, stdout="", stderr="")

    monkeypatch.setattr(gpu_display.subprocess, "run", fake_run)
    config = make_config(gpu_display=True, display=":88")

    try:
        gpu_display.ensure_gpu_display(config, {}, log=lambda _m: None)
        assert False, "RuntimeErrorが送出されるべき"
    except RuntimeError as err:
        assert "BusID" in str(err)


def test_ensure_gpu_display_starts_xorg_and_applies_crtc_mode(monkeypatch, tmp_path):
    monkeypatch.setattr(gpu_display.time, "sleep", lambda _s: None)
    run_calls = []
    popen_calls = []

    def fake_run(cmd, **kwargs):
        run_calls.append(list(cmd))
        if cmd[0] == "xdotool":
            return subprocess.CompletedProcess(cmd, returncode=1)
        if cmd[0] == "nvidia-xconfig":
            return subprocess.CompletedProcess(cmd, returncode=0, stdout="PCI BusID : PCI:49:0:0\n")
        if cmd[0] == "xrandr" and cmd[1:2] == ["--query"]:
            return subprocess.CompletedProcess(
                cmd, returncode=0, stdout="DVI-D-0 connected primary 1024x768+0+0\n",
            )
        return subprocess.CompletedProcess(cmd, returncode=0)

    def fake_popen(cmd, **kwargs):
        popen_calls.append(list(cmd))

        class _Proc:
            pass

        return _Proc()

    monkeypatch.setattr(gpu_display.subprocess, "run", fake_run)
    monkeypatch.setattr(gpu_display.subprocess, "Popen", fake_popen)

    config = make_config(gpu_display=True, display=":88", xvfb_screen="2200x1400x24", crtc_mode="1920x1080")

    gpu_display.ensure_gpu_display(config, {}, log=lambda _m: None)

    assert any(c[0] == "Xorg" for c in popen_calls)
    assert any(c[0] == "openbox" for c in popen_calls)
    xrandr_set_calls = [c for c in run_calls if c[0] == "xrandr" and "--output" in c]
    assert xrandr_set_calls == [["xrandr", "--output", "DVI-D-0", "--mode", "1920x1080"]]


def test_ensure_gpu_display_skips_crtc_change_when_not_specified(monkeypatch):
    monkeypatch.setattr(gpu_display.time, "sleep", lambda _s: None)
    run_calls = []

    def fake_run(cmd, **kwargs):
        run_calls.append(list(cmd))
        if cmd[0] == "xdotool":
            return subprocess.CompletedProcess(cmd, returncode=1)
        if cmd[0] == "nvidia-xconfig":
            return subprocess.CompletedProcess(cmd, returncode=0, stdout="PCI BusID : PCI:49:0:0\n")
        return subprocess.CompletedProcess(cmd, returncode=0)

    monkeypatch.setattr(gpu_display.subprocess, "run", fake_run)
    monkeypatch.setattr(gpu_display.subprocess, "Popen", lambda cmd, **k: object())

    config = make_config(gpu_display=True, display=":88", xvfb_screen="1280x720x24")

    gpu_display.ensure_gpu_display(config, {}, log=lambda _m: None)

    assert not any(c[0] == "xrandr" for c in run_calls)
