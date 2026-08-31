import record_th06


def test_build_config_uses_th06_canonical_slot_and_paths():
    config = record_th06.build_config("sattori_job_test")

    assert config.game_id == "th06"
    # th07/th08と異なりリネームしない。VsyncPatchが実行ファイル名を検証しているらしく、
    # `th06.exe`へリネームすると白画面ハングが再発することを実機検証で確認した
    # (docs/titles/th06.md参照)。
    assert config.game_exe == "東方紅魔郷.exe"
    # /proc/PID/commの15バイト切り詰め対策(touhou-recorder reports/31)。
    assert config.process_name == "東方紅魔郷"
    assert config.hook_dll == "th06_hook.dll"
    # th07/th08の`th{N}_ud####.rpy`命名則を踏襲したもの。2026-07-23にローカル実機
    # スモークテストで検証済み(docs/titles/th06.md)。
    assert config.canonical_slot == "th6_ud0000.rpy"
    assert config.injector_path.endswith("mods/common/build/injector.exe")
    assert config.hook_dll_path.endswith("mods/th06_replay_autoplay/build/th06_hook.dll")
    # wined3dの白画面ハング回避に必須のVsyncPatch(touhou-recorder reports/30)を、
    # MOD本体より前に注入する。
    assert config.extra_dlls == ("vpatch_th06.dll",)
