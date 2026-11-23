import record_th14


def test_build_config_uses_th14_canonical_slot_and_paths():
    config = record_th14.build_config("sattori_job_test")

    assert config.game_id == "th14"
    assert config.game_exe == "th14.exe"
    assert config.hook_dll == "th14_hook.dll"
    # MOD(th14_replay_autoplay/dllmain.cpp)はユーザータブの先頭スロットを選ぶ固定
    # シーケンスのため、この名前で配置する必要がある(touhou-recorder reports/103)。
    assert config.canonical_slot == "th14_ud0000.rpy"
    assert config.injector_path.endswith("mods/common/build/injector.exe")
    assert config.hook_dll_path.endswith("mods/th14_replay_autoplay/build/th14_hook.dll")


def test_build_config_requests_a_larger_xvfb_screen():
    # th14はth15・th20と同じ960p相当の内部描画解像度(1280x960ウィンドウ)。
    config = record_th14.build_config("sattori_job_test")

    assert config.xvfb_screen == "1400x1100x24"


def test_build_config_reads_cfg_and_replay_from_the_appdata_profile():
    # th14はcfg/リプレイを%APPDATA%/ShanghaiAlice/th14/から読む(reports/103)。
    config = record_th14.build_config("sattori_job_test")

    assert config.uses_appdata_profile is True
    assert config.cfg_filename == "th14.cfg"


def test_build_config_does_not_use_gpu_display_or_thprac(monkeypatch):
    # GPUの段は持たない(GPUでの倍速録画は未検証)。GPU_WORKERが渡されてもCPU描画のまま。
    monkeypatch.setenv("GPU_WORKER", "1")
    config = record_th14.build_config("sattori_job_test")

    assert config.gpu_display is False
    assert config.extra_dlls == ()
    assert config.thprac_exe is None


def test_build_config_excludes_the_post_replay_menu_rect():
    config = record_th14.build_config("sattori_job_test")

    assert config.still_detect_exclude_rect == [(85, 426, 380, 855)]


def test_build_config_uses_a_display_number_not_shared_with_other_titles():
    """同一ホストで並列録画しても映像が混ざらないよう、タイトルごとに固定する。"""
    import importlib

    others = ("th06", "th06c", "th06nc", "th07", "th08", "th09", "th10", "th11", "th12", "th13",
              "th15", "th20", "th128")
    displays = {
        importlib.import_module(f"record_{game}").build_config("sattori_job_test").display
        for game in others
    }
    assert record_th14.build_config("sattori_job_test").display not in displays


def test_build_config_detects_the_replay_list_screen_for_spell_practice_timeouts():
    """耐久で時間切れにしたスペルプラクティスは一覧画面へ戻り、画面静止が成立しない
    (docs/reports/2026-11-24-spell-practice-timeout-end-detection.md)。"""
    config = record_th14.build_config("sattori_job_test")

    assert config.replay_list_detect is True
    assert config.replay_list_exclude_rows == (18, 25)
    assert config.replay_list_mad_threshold == None
    assert config.replay_list_template_path.endswith("assets/replay_end_templates/th14_replay_list.png")
