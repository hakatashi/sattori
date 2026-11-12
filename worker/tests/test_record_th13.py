import record_th13


def test_build_config_uses_th13_canonical_slot_and_paths():
    config = record_th13.build_config("sattori_job_test")

    assert config.game_id == "th13"
    assert config.game_exe == "th13.exe"
    assert config.hook_dll == "th13_hook.dll"
    # MOD(th13_replay_autoplay/dllmain.cpp)はユーザータブの先頭スロットを選ぶ固定
    # シーケンスのため、この名前で配置する必要がある(touhou-recorder reports/100)。
    assert config.canonical_slot == "th13_ud0000.rpy"
    assert config.injector_path.endswith("mods/common/build/injector.exe")
    assert config.hook_dll_path.endswith("mods/th13_replay_autoplay/build/th13_hook.dll")


def test_build_config_reads_cfg_and_replay_from_the_appdata_profile():
    # th13はcfg/リプレイを%APPDATA%/ShanghaiAlice/th13/から読む(reports/100)。
    config = record_th13.build_config("sattori_job_test")

    assert config.uses_appdata_profile is True
    assert config.cfg_filename == "th13.cfg"


def test_build_config_does_not_use_vsyncpatch_or_thprac():
    # VsyncPatchなしで60Hzに安定する(reports/100)。thpracはRVAの参照元として使っただけ。
    config = record_th13.build_config("sattori_job_test")

    assert config.extra_dlls == ()
    assert config.thprac_exe is None


def test_build_config_excludes_the_post_replay_menu_rect():
    config = record_th13.build_config("sattori_job_test")

    assert config.still_detect_exclude_rect == (48, 220, 207, 432)


def test_slow_motion_also_slows_down_qpc(monkeypatch):
    # 1/2倍速はPresent上限とQPC偽装の両方で減速する構成で検証した(reports/100)。
    monkeypatch.setenv("FPS_LIMIT_TARGET_HZ", "30")
    config = record_th13.build_config("sattori_job_test")

    assert config.build_env()["SPEED_HACK_MULTIPLIER"] == "0.5"


def test_native_speed_does_not_set_speed_hack(monkeypatch):
    monkeypatch.delenv("FPS_LIMIT_TARGET_HZ", raising=False)
    monkeypatch.delenv("SPEED_HACK_MULTIPLIER", raising=False)
    config = record_th13.build_config("sattori_job_test")

    assert "SPEED_HACK_MULTIPLIER" not in config.build_env()


def test_build_config_uses_a_display_number_not_shared_with_other_titles():
    """同一ホストで並列録画しても映像が混ざらないよう、タイトルごとに固定する。"""
    import importlib

    others = ("th06", "th06c", "th06nc", "th07", "th08", "th09", "th10", "th11", "th12", "th15",
              "th20", "th128")
    displays = {
        importlib.import_module(f"record_{game}").build_config("sattori_job_test").display
        for game in others
    }
    assert record_th13.build_config("sattori_job_test").display not in displays
