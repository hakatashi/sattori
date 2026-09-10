import record_th06c


def test_build_config_uses_th06c_canonical_slot_and_paths():
    config = record_th06c.build_config("sattori_job_test")

    assert config.game_id == "th06c"
    assert config.game_exe == "th06c.exe"
    assert config.hook_dll == "th06c_hook.dll"
    # th06cはディレクトリ列挙方式で常に1番目のファイルを選ぶため、正規スロット名は
    # 実質どんな値でもよい(docs/titles/th06c.md、touhou-recorder reports/75)。
    assert config.canonical_slot == "th6_01.rpy"
    # th06c.exeはPE32+(x86-64)のため、他タイトル共通の32bit injector.exeではなく
    # 64bit版を明示的に指定する(docs/titles/th06c.md)。
    assert config.injector == "injector64.exe"
    assert config.injector_path.endswith("mods/common/build/injector64.exe")
    assert config.hook_dll_path.endswith("mods/th06c_replay_autoplay/build/th06c_hook.dll")
    # 起動ダイアログの解像度選択で640x480ウィンドウが画面外へはみ出さないよう、
    # 既定のXvfb画面(800x600x24)より広く取る(docs/titles/th06c.md)。
    assert config.xvfb_screen == "1400x1100x24"
    # リプレイ選択画面の見出し帯だけに絞り込んだ終了検知(touhou-recorder reports/76)。
    assert config.end_template_rect == (20, 78, 560, 152)
