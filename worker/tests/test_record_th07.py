import record_th07


def test_build_config_uses_th07_canonical_slot_and_paths():
    config = record_th07.build_config()

    assert config.game_id == "th07"
    assert config.game_exe == "th07.exe"
    assert config.hook_dll == "th07_hook.dll"
    # th07のリプレイ一覧で1件目に並ぶ正規スロット名。任意ファイル名のアップロード
    # リプレイをこの名前で配置することで、MODの「1件目固定選択」ロジックのまま
    # 任意のリプレイを再生できる。
    assert config.canonical_slot == "th7_ud0000.rpy"
    assert config.injector_path.endswith("mods/common/build/injector.exe")
    assert config.hook_dll_path.endswith("mods/th07_replay_autoplay/build/th07_hook.dll")
