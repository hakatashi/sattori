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
    # 言語は既定が日本語(Issue #378)。GPU描画ではそれ以外の環境変数は渡さない。
    assert config.extra_env == (("STEAM_GAME_LANGUAGE", "japanese"),)
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
    assert "TH06NC_TIME_SCALE" not in env


@pytest.mark.parametrize("language", [
    "english", "schinese", "tchinese", "koreana", "french", "german",
    "spanish", "latam", "russian", "brazilian", "italian",
])
def test_build_config_passes_requested_language_to_the_steam_stub(monkeypatch, language):
    monkeypatch.setenv("TH06NC_LANGUAGE", language)

    config = record_th06nc.build_config("sattori_job_test")

    assert ("STEAM_GAME_LANGUAGE", language) in config.extra_env


@pytest.mark.parametrize("value", ["", "klingon", "JAPANESE", "en"])
def test_build_config_falls_back_to_japanese_for_unknown_language(monkeypatch, value):
    # Steamの言語名以外を渡すと、ゲームが未知の言語として何を表示するか不明なので日本語にする。
    monkeypatch.setenv("TH06NC_LANGUAGE", value)

    config = record_th06nc.build_config("sattori_job_test")

    assert ("STEAM_GAME_LANGUAGE", "japanese") in config.extra_env


def test_build_config_keeps_cpu_rendering_env_alongside_language(monkeypatch):
    monkeypatch.delenv("GPU_WORKER", raising=False)
    monkeypatch.setenv("TH06NC_LANGUAGE", "french")

    config = record_th06nc.build_config("sattori_job_test")

    env = dict(config.extra_env)
    assert env["STEAM_GAME_LANGUAGE"] == "french"
    assert env["D3D11_DECODE_BC7"] == "1"


def test_languages_match_the_shared_typescript_list():
    # `packages/shared/src/th06ncLanguage.ts`の`TH06NC_LANGUAGES`(APIがワーカーへ渡す値の集合)と
    # 食い違うと、UIで選べる言語がワーカーで日本語に化ける。
    import re
    from pathlib import Path

    source = (Path(record_th06nc.__file__).resolve().parents[1]
              / "packages/shared/src/th06ncLanguage.ts").read_text(encoding="utf-8")
    body = re.search(r"TH06NC_LANGUAGES = \[(.*?)\] as const", source, re.S).group(1)
    assert set(re.findall(r'"(\w+)"', body)) == record_th06nc._LANGUAGES
