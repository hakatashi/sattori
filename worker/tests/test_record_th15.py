import record_th15


def test_build_config_uses_th15_canonical_slot_and_paths():
    config = record_th15.build_config("sattori_job_test")

    assert config.game_id == "th15"
    assert config.game_exe == "th15.exe"
    assert config.hook_dll == "th15_hook.dll"
    # th11/th20と同じユーザーリプレイタブの先頭スロット固定シーケンスのため、
    # この名前で配置する必要がある(touhou-recorder reports/82)。
    assert config.canonical_slot == "th15_ud0000.rpy"
    assert config.injector_path.endswith("mods/common/build/injector.exe")
    assert config.hook_dll_path.endswith("mods/th15_replay_autoplay/build/th15_hook.dll")


def test_build_config_requests_a_larger_xvfb_screen():
    # th15はth20と同じ960p相当の内部描画解像度(1280x960ウィンドウ)。
    config = record_th15.build_config("sattori_job_test")

    assert config.xvfb_screen == "1400x1100x24"


def test_build_config_reads_cfg_and_replay_from_the_appdata_profile():
    # th125以降のエンジンはcfg/リプレイをゲーム本体ディレクトリではなく
    # %APPDATA%/ShanghaiAlice/th15/から読む(touhou-recorder reports/82)。
    config = record_th15.build_config("sattori_job_test")

    assert config.uses_appdata_profile is True
    assert config.cfg_filename == "th15.cfg"


def test_build_config_uses_gpu_display_without_dxvk():
    # GPU描画必須(Issue #82)。th06ncと異なりDXVKはVulkan機能不足で起動できない
    # ため使わず、wined3d(OpenGL)のままGPUを使う(touhou-recorder reports/82)。
    config = record_th15.build_config("sattori_job_test")

    assert config.gpu_display is True
    assert config.dxvk_dll_overrides is None
    # Xorg+nvidia環境でウィンドウがCRTCの既定モード(1024x768)へ縮小される
    # 既知の症状(th06ncの1080p検証時と同じ)への対策。
    assert config.crtc_mode == "1280x960"


def test_build_config_excludes_the_post_replay_menu_rect():
    # リプレイ終了後の「再生終了/ゲームを終了/もう一度再生する」メニューのテキスト
    # 全体を静止判定から除外する(1280x960のウィンドウ座標系、touhou-recorder reports/82)。
    config = record_th15.build_config("sattori_job_test")

    assert config.still_detect_exclude_rect == [(81, 350, 470, 800)]


def test_build_config_does_not_attach_thprac():
    # thpracはRVA調査の参照元として使ったのみで、th20と異なりデシンク対策として
    # 実機で必要性が確認されていないためアタッチしない(touhou-recorder reports/82)。
    config = record_th15.build_config("sattori_job_test")

    assert config.thprac_exe is None


def test_build_config_uses_a_display_number_not_shared_with_other_titles():
    """同一ホストで並列録画しても映像が混ざらないよう、タイトルごとに固定する。"""
    import record_th06
    import record_th07
    import record_th08
    import record_th11
    import record_th20

    displays = {
        module.build_config("sattori_job_test").display
        for module in (record_th06, record_th07, record_th08, record_th11, record_th15, record_th20)
    }
    assert len(displays) == 6
