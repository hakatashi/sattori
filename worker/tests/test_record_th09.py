import record_th09


def test_build_config_uses_th09_canonical_slot_and_paths():
    config = record_th09.build_config("sattori_job_test")

    assert config.game_id == "th09"
    assert config.game_exe == "th09.exe"
    assert config.hook_dll == "th09_hook.dll"
    # th11/th12と同じユーザータブ方式(MOD(th09_replay_autoplay/dllmain.cpp)は
    # ユーザータブへ切り替えた上で先頭スロットを選ぶ固定シーケンスのため、この名前で
    # 配置する必要がある(touhou-recorder reports/68)。実行ファイル名はth09.exeだが、
    # リプレイファイル名の接頭辞は"th9_"(th09ではなくth9)。
    assert config.canonical_slot == "th9_ud0000.rpy"
    assert config.injector_path.endswith("mods/common/build/injector.exe")
    assert config.hook_dll_path.endswith("mods/th09_replay_autoplay/build/th09_hook.dll")


def test_build_config_does_not_use_vsyncpatch():
    # VsyncPatchはゲームデータに同梱されているが不具合時のみ使う位置づけで、
    # 録画では常に無効(docs/titles/th09.md)。
    config = record_th09.build_config("sattori_job_test")

    assert config.extra_dlls == ()


def test_build_config_sets_end_template_rect():
    # リプレイ選択画面「映花一覧」の見出し部分のみに絞り込む(0000スロットの
    # 内容(スコア・日付)を含めると誤判定するため、th10と同様の対応。
    # touhou-recorder reports/68)。
    config = record_th09.build_config("sattori_job_test")

    assert config.end_template_rect == (0, 0, 230, 88)
