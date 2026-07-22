import record_th06


def test_build_config_uses_th06_canonical_slot_and_paths():
    config = record_th06.build_config()

    assert config.game_id == "th06"
    assert config.game_exe == "th06.exe"
    assert config.hook_dll == "th06_hook.dll"
    # th07/th08の`th{N}_ud####.rpy`命名則を踏襲しているが、実ゲームデータでの
    # 実機検証はまだ済んでいない(未検証事項、record_th06.pyのモジュールdocstring参照)。
    assert config.canonical_slot == "th6_ud0000.rpy"
    assert config.injector_path.endswith("mods/common/build/injector.exe")
    assert config.hook_dll_path.endswith("mods/th06_replay_autoplay/build/th06_hook.dll")
    # wined3dの白画面ハング回避に必須のVsyncPatch(touhou-recorder reports/30)を、
    # MOD本体より前に注入する。
    assert config.extra_dlls == ("vpatch_th06.dll",)
