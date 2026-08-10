import record_th20


def test_build_config_uses_th20_canonical_slot_and_paths():
    config = record_th20.build_config("sattori_job_test")

    assert config.game_id == "th20"
    assert config.game_exe == "th20.exe"
    assert config.hook_dll == "th20_hook.dll"
    # th11と同じくユーザーリプレイタブの先頭スロットを固定で選ぶシーケンスのため、
    # この名前で配置する必要がある(touhou-recorder reports/44)。
    assert config.canonical_slot == "th20_ud0000.rpy"
    assert config.injector_path.endswith("mods/common/build/injector.exe")
    assert config.hook_dll_path.endswith("mods/th20_replay_autoplay/build/th20_hook.dll")


def test_build_config_requests_a_larger_xvfb_screen():
    # th14以降は内部描画解像度が960p相当。th20は1280x960ウィンドウで起動するため、
    # 既定の800x600のままだとx11grabが起動に失敗する(reports/44)。
    config = record_th20.build_config("sattori_job_test")

    assert config.xvfb_screen == "1400x1100x24"


def test_build_config_reads_cfg_and_replay_from_the_appdata_profile():
    # th125以降のエンジンはcfg/リプレイをゲーム本体ディレクトリではなく
    # %APPDATA%/ShanghaiAlice/th20/から読む。cfgが無いと初回起動時の解像度選択
    # ダイアログで止まる(reports/44・46)。
    config = record_th20.build_config("sattori_job_test")

    assert config.uses_appdata_profile is True
    assert config.cfg_filename == "th20.cfg"


def test_build_config_excludes_both_trailing_animation_rects():
    # リプレイ終了後も2箇所で背景アニメーションが継続するため、両方を静止判定の
    # MAD計算から除外しないと自然終了を検知できない(reports/45)。
    config = record_th20.build_config("sattori_job_test")

    assert config.still_detect_exclude_rect == [
        (68, 245, 474, 849),
        (851, 488, 1271, 908),
    ]


def test_build_config_uses_a_display_number_not_shared_with_other_titles():
    """同一ホストで並列録画しても映像が混ざらないよう、タイトルごとに固定する。"""
    import record_th06
    import record_th07
    import record_th08
    import record_th11

    displays = {
        module.build_config("sattori_job_test").display
        for module in (record_th06, record_th07, record_th08, record_th11, record_th20)
    }
    assert len(displays) == 5
