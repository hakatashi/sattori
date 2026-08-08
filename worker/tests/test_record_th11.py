import record_th11


def test_build_config_uses_th11_canonical_slot_and_paths():
    config = record_th11.build_config("sattori_job_test")

    assert config.game_id == "th11"
    assert config.game_exe == "th11.exe"
    assert config.hook_dll == "th11_hook.dll"
    # th11のリプレイ一覧は組み込みスロット(No.01〜)とユーザーリプレイタブ(ud0000〜)に
    # 分かれており、MOD(th11_replay_autoplay/dllmain.cpp)はユーザータブへ切り替えた
    # 上で先頭スロットを選ぶ固定シーケンスのため、この名前で配置する必要がある
    # (touhou-recorder reports/35)。
    assert config.canonical_slot == "th11_ud0000.rpy"
    assert config.injector_path.endswith("mods/common/build/injector.exe")
    assert config.hook_dll_path.endswith("mods/th11_replay_autoplay/build/th11_hook.dll")


def test_build_config_sets_pause_menu_cursor_exclude_rect():
    # Pause Menu画面の選択カーソル明滅で画面静止検知が機能しなくなる問題への対策
    # (touhou-recorder reports/37・38)。
    config = record_th11.build_config("sattori_job_test")

    assert config.still_detect_exclude_rect == (70, 288, 188, 318)
