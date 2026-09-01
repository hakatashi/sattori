import record_th12


def test_build_config_uses_th12_canonical_slot_and_paths():
    config = record_th12.build_config("sattori_job_test")

    assert config.game_id == "th12"
    assert config.game_exe == "th12.exe"
    assert config.hook_dll == "th12_hook.dll"
    # th11と同じユーザータブ方式(MOD(th12_replay_autoplay/dllmain.cpp)はユーザータブへ
    # 切り替えた上で先頭スロットを選ぶ固定シーケンスのため、この名前で配置する必要がある
    # (touhou-recorder reports/61)。
    assert config.canonical_slot == "th12_ud0000.rpy"
    assert config.injector_path.endswith("mods/common/build/injector.exe")
    assert config.hook_dll_path.endswith("mods/th12_replay_autoplay/build/th12_hook.dll")


def test_build_config_enables_vsyncpatch_unconditionally():
    # ユーザー指示により、th10のBugFixTh10Power3のようなini切替オプションは無く、
    # VsyncPatchは常に有効な状態で録画する(docs/titles/th12.md)。
    config = record_th12.build_config("sattori_job_test")

    assert config.extra_dlls == ("vpatch_th12.dll",)
    assert config.vpatch_ini_overrides == ()


def test_build_config_sets_pause_menu_cursor_exclude_rect():
    # Pause Menu画面の選択カーソル明滅で画面静止検知が機能しなくなる問題への対策
    # (th11と同じ、touhou-recorder reports/61)。
    config = record_th12.build_config("sattori_job_test")

    assert config.still_detect_exclude_rect == (48, 214, 203, 430)


def test_build_config_sets_force_window_map():
    # ゲームウィンドウが最小化(Iconic)状態で作成される既知の不具合対策
    # (touhou-recorder reports/61)。
    config = record_th12.build_config("sattori_job_test")

    assert config.force_window_map is True
