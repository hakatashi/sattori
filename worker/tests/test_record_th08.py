import record_th08


def test_build_config_uses_th08_canonical_slot_and_paths():
    config = record_th08.build_config()

    assert config.game_id == "th08"
    assert config.game_exe == "th08.exe"
    assert config.hook_dll == "th08_hook.dll"
    # th07の`th7_ud0000.rpy`と同じ命名則。touhou-recorderの実ゲームデータ(ver1.00d)で
    # このファイル名が「1件目のリプレイ」として認識・選択されることを実機検証済み
    # (Issue #13対応時、touhou-recorderのreports/22〜26では未検証だったため別途確認した)。
    assert config.canonical_slot == "th8_ud0000.rpy"
    assert config.injector_path.endswith("mods/common/build/injector.exe")
    assert config.hook_dll_path.endswith("mods/th08_replay_autoplay/build/th08_hook.dll")
