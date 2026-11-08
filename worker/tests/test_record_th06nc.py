import record_th06nc


import pytest


@pytest.fixture(autouse=True)
def _gpu_worker(monkeypatch):
    # 既定はGPUワーカー。CPU描画のテストだけが外す。
    monkeypatch.setenv("GPU_WORKER", "1")
    monkeypatch.delenv("FPS_LIMIT_TARGET_HZ", raising=False)


def test_build_config_defaults_to_720p(monkeypatch):
    monkeypatch.delenv("TH06NC_RESOLUTION", raising=False)

    config = record_th06nc.build_config("sattori_job_test")

    assert config.game_id == "th06nc"
    assert config.game_exe == "th06nc.exe"
    assert config.hook_dll == "th06nc_hook.dll"
    assert config.canonical_slot == "th6_01.rpy"
    # th06nc.exeはPE32+(x86-64)のため64bit injectorを使う(th06cと同じ)。
    assert config.injector == "injector64.exe"
    assert config.injector_path.endswith("mods/common/build/injector64.exe")
    assert config.hook_dll_path.endswith("mods/th06nc_replay_autoplay/build/th06nc_hook.dll")
    # GPU描画必須タイトル(Issue #241)。
    assert config.gpu_display is True
    assert config.dxvk_dll_overrides == "d3d11,dxgi,d3d10core=n"
    assert config.poll_side_stream is True
    assert config.extra_env == ()
    assert config.slow_motion_speed_hack is True
    # 720p既定ではCRTCモードの明示変更は不要(Xorgのデフォルトモードのままでよい、
    # touhou-recorder reports/81 §9.9.1)。
    assert config.crtc_mode is None
    assert len(config.extra_instance_files) == 1
    src, dest = config.extra_instance_files[0]
    assert src.endswith("th06.env.720p")
    assert dest == "th06.env"
    # 720p基準の除外矩形はそのまま(スケールなし)。
    assert config.still_detect_exclude_rect == [(0, 0, 352, 720), (934, 0, 1280, 720)]


def test_build_config_switches_to_1080p_when_requested(monkeypatch):
    monkeypatch.setenv("TH06NC_RESOLUTION", "1080p")

    config = record_th06nc.build_config("sattori_job_test")

    assert config.crtc_mode == "1920x1080"
    src, dest = config.extra_instance_files[0]
    assert src.endswith("th06.env.1080p")
    assert dest == "th06.env"
    # 1280x720 -> 1920x1080は1.5倍。
    assert config.still_detect_exclude_rect == [(0, 0, 528, 1080), (1401, 0, 1920, 1080)]


def test_build_config_falls_back_to_720p_for_unknown_resolution(monkeypatch):
    monkeypatch.setenv("TH06NC_RESOLUTION", "4k")

    config = record_th06nc.build_config("sattori_job_test")

    assert config.crtc_mode is None
    src, _dest = config.extra_instance_files[0]
    assert src.endswith("th06.env.720p")


def test_build_config_renders_on_the_cpu_without_a_gpu_worker(monkeypatch):
    """CPU描画はwined3dのビルトイン+BC7展開(touhou-recorder reports/96・97)。"""
    monkeypatch.delenv("GPU_WORKER", raising=False)
    monkeypatch.delenv("TH06NC_RESOLUTION", raising=False)

    config = record_th06nc.build_config("sattori_job_test")

    assert config.gpu_display is False
    assert config.dxvk_dll_overrides == "d3d11,dxgi,d3d10core=b"
    assert config.poll_side_stream is False
    assert config.crtc_mode is None
    env = dict(config.extra_env)
    assert env["D3D11_DECODE_BC7"] == "1"
    assert int(env["LP_NUM_THREADS"]) >= 1
    # 等倍ではメニュー待ちを伸ばさない。
    assert "TH06NC_TIME_SCALE" not in env


def test_build_config_stretches_menu_waits_for_slow_motion_on_the_cpu(monkeypatch):
    monkeypatch.delenv("GPU_WORKER", raising=False)
    monkeypatch.setenv("FPS_LIMIT_TARGET_HZ", "30")

    config = record_th06nc.build_config("sattori_job_test")

    assert dict(config.extra_env)["TH06NC_TIME_SCALE"] == "2"
    assert config.build_env()["SPEED_HACK_MULTIPLIER"] == "0.5"
