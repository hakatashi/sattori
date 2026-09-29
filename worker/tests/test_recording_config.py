"""GameConfig の既定値の導出と、タイトルごとの上書き。"""

from recording.config import WORKER_ROOT, XVFB_SCREEN, GameConfig
from recording_helpers import make_config


def test_game_config_derives_exe_dll_and_log_path_from_game_id():
    config = make_config()

    assert config.game_exe == "th08.exe"
    assert config.hook_dll == "th08_hook.dll"
    assert config.log_path == "/instance/th08_autoplay.log"


def test_game_config_extra_dlls_defaults_to_empty():
    config = make_config()

    assert config.extra_dlls == ()


def test_game_config_process_name_defaults_to_game_exe():
    config = make_config()

    assert config.process_name == config.game_exe == "th08.exe"


def test_game_config_allows_overriding_game_exe_and_process_name():
    # th06はVsyncPatchが実行ファイル名を検証しているらしく、th{N}.exeへリネームすると
    # 白画面ハングが再発するため元のファイル名のまま使う(docs/titles/th06.md参照)。/proc/PID/commは15バイトで切り詰められるため、pgrep/pkill専用の
    # process_nameは拡張子なしの別の値を指定する(touhou-recorder reports/31)。
    config = make_config(
        game_id="th06", game_exe="東方紅魔郷.exe", process_name="東方紅魔郷",
    )

    assert config.game_exe == "東方紅魔郷.exe"
    assert config.process_name == "東方紅魔郷"


def test_game_config_build_env_sets_wine_and_locale_vars():
    config = make_config()

    env = config.build_env()

    assert env["WINEPREFIX"] == "/prefix"
    assert env["DISPLAY"] == ":98"
    assert env["LANG"] == "ja_JP.UTF-8"
    assert env["LC_ALL"] == "ja_JP.UTF-8"
    # Wineの音声出力先をジョブ専用sinkへ固定する(Issue #48)。無指定だとデフォルトsinkへ
    # 流れ、同一ホストでの並列録画で全ジョブの音声が混ざる。
    assert env["PULSE_SINK"] == "sattori_job_test"


def test_game_config_derives_pulse_source_from_pulse_sink():
    # 録音側ffmpegの入力はジョブ専用sinkのmonitor(タイトル固定の`auto_null.monitor`では
    # なくなった、Issue #48)。
    config = make_config(pulse_sink="sattori_job_abc")

    assert config.pulse_source == "sattori_job_abc.monitor"


def test_game_config_gpu_fields_default_to_disabled():
    # Issue #241: GPU描画必須タイトル(th06nc)専用のフィールド。既存9タイトルは
    # 触れないため既定値のまま。
    config = make_config()

    assert config.gpu_display is False
    assert config.dxvk_dll_overrides is None
    assert config.crtc_mode is None
    assert config.poll_side_stream is False
    assert config.extra_instance_files == ()


def test_game_config_build_env_sets_winedlloverrides_when_dxvk_specified():
    config = make_config(dxvk_dll_overrides="d3d11,dxgi,d3d10core=n")

    env = config.build_env()

    assert env["WINEDLLOVERRIDES"] == "d3d11,dxgi,d3d10core=n"


def test_game_config_build_env_omits_winedlloverrides_by_default():
    config = make_config()

    env = config.build_env()

    assert "WINEDLLOVERRIDES" not in env


def test_game_config_still_detect_exclude_rect_defaults_to_none():
    config = make_config()

    assert config.still_detect_exclude_rect is None


def test_game_config_allows_overriding_still_detect_exclude_rect():
    config = make_config(game_id="th11", still_detect_exclude_rect=(70, 288, 188, 318))

    assert config.still_detect_exclude_rect == (70, 288, 188, 318)


def test_game_config_end_template_path_defaults_under_the_worker_root():
    """未指定ならworkerルート配下のassets/replay_end_templates/{game_id}.pngを使う。

    **`recording/config.py`の`__file__`を起点にしてはならない**(assets/はworker直下)。
    間違えても例外は出ず、load_end_template()がNoneを返して画面静止のみ判定へ
    フォールバックするため、終了検知の劣化としてしか表面化しない(reports/33・34)。
    """
    config = make_config(game_id="th07")

    assert config.end_template_path == f"{WORKER_ROOT}/assets/replay_end_templates/th07.png"
    assert WORKER_ROOT.endswith("/worker")


def test_game_config_allows_overriding_end_template_path():
    config = make_config(end_template_path="/custom/th08.png")

    assert config.end_template_path == "/custom/th08.png"


def test_game_config_thprac_exe_defaults_to_none():
    config = make_config()

    assert config.thprac_exe is None


def test_game_config_force_window_map_defaults_to_false():
    config = make_config()

    assert config.force_window_map is False


def test_game_config_allows_overriding_force_window_map():
    # th12はウィンドウが最小化(Iconic)状態で生成される既知の不具合対策として
    # force_window_map=Trueを渡す(docs/titles/th12.md、touhou-recorder reports/61)。
    config = make_config(game_id="th12", force_window_map=True)

    assert config.force_window_map is True


# --- th20 向けの GameConfig 拡張(Issue #87) --------------------------------


def test_xvfb_screen_defaults_to_shared_value_and_can_be_overridden():
    assert make_config().xvfb_screen == XVFB_SCREEN
    assert make_config(xvfb_screen="1400x1100x24").xvfb_screen == "1400x1100x24"


def test_cfg_filename_defaults_to_game_id():
    assert make_config(game_id="th20").cfg_filename == "th20.cfg"


# --- for_game(): game_id から機械的に決まる値の導出(Issue #188) ---------------


def test_for_game_derives_every_path_from_the_game_id():
    """6つの record_thNN.py で書き写していた導出。1つでもずれると別タイトルの資産を掴む。"""
    cfg = GameConfig.for_game("th11", "sattori_job_test", display=":99",
                              canonical_slot="th11_ud0000.rpy")

    assert cfg.instance_dir == f"{WORKER_ROOT}/instances/th11-recording"
    assert cfg.game_dir_src == f"{WORKER_ROOT}/games/th11"
    assert cfg.wineprefix == f"{WORKER_ROOT}/prefixes/th11-wined3d-gl"
    assert cfg.injector_path == f"{WORKER_ROOT}/mods/common/build/injector.exe"
    assert cfg.hook_dll_path == f"{WORKER_ROOT}/mods/th11_replay_autoplay/build/th11_hook.dll"
    assert cfg.display == ":99"


def test_for_game_lets_the_environment_override_the_derived_paths(monkeypatch):
    """ローカル単体実行でゲームデータの置き場所を差し替える経路(docs/reports/の再現手順)。"""
    monkeypatch.setenv("SATTORI_INSTANCE_DIR", "/tmp/inst")
    monkeypatch.setenv("SATTORI_GAME_DIR", "/tmp/game")
    monkeypatch.setenv("SATTORI_MOD_DIR", "/tmp/mods")
    monkeypatch.setenv("WINEPREFIX", "/tmp/prefix")
    monkeypatch.setenv("SATTORI_DISPLAY", ":42")

    cfg = GameConfig.for_game("th06", "sattori_job_test", display=":96",
                              canonical_slot="th6_ud0000.rpy")

    assert cfg.instance_dir == "/tmp/inst"
    assert cfg.game_dir_src == "/tmp/game"
    assert cfg.wineprefix == "/tmp/prefix"
    assert cfg.injector_path == "/tmp/mods/common/build/injector.exe"
    assert cfg.hook_dll_path == "/tmp/mods/th06_replay_autoplay/build/th06_hook.dll"
    assert cfg.display == ":42"


def test_for_game_passes_title_specific_overrides_through():
    cfg = GameConfig.for_game("th06", "sattori_job_test", display=":96",
                              canonical_slot="th6_ud0000.rpy",
                              game_exe="東方紅魔郷.exe", process_name="東方紅魔郷",
                              extra_dlls=("vpatch_th06.dll",))

    assert cfg.game_exe == "東方紅魔郷.exe"
    assert cfg.process_name == "東方紅魔郷"
    assert cfg.extra_dlls == ("vpatch_th06.dll",)


def test_for_game_allows_overriding_injector_path_and_injector():
    """th06c.exeはPE32+(x86-64)のため、他タイトル共通の32bit injector.exeではなく
    64bit版を明示的に指定する必要がある(docs/titles/th06c.md)。`overrides`は
    `for_game()`が組み立てる`defaults`のキー(`injector_path`)も上書きできること。
    """
    cfg = GameConfig.for_game("th06c", "sattori_job_test", display=":102",
                              canonical_slot="th6_01.rpy",
                              injector="injector64.exe",
                              injector_path=f"{WORKER_ROOT}/mods/common/build/injector64.exe")

    assert cfg.injector == "injector64.exe"
    assert cfg.injector_path == f"{WORKER_ROOT}/mods/common/build/injector64.exe"
    # 上書きしていないhook_dll_pathは従来どおりgame_idから機械的に導出される。
    assert cfg.hook_dll_path == f"{WORKER_ROOT}/mods/th06c_replay_autoplay/build/th06c_hook.dll"



# --- 実行時の上書き(倍速録画・GPUワーカー、Issue #288) ---------------------

from recording.config import with_runtime_overrides  # noqa: E402


def test_build_env_derives_the_speed_hack_multiplier_from_the_target_hz(monkeypatch):
    """倍率は起動側が渡す`FPS_LIMIT_TARGET_HZ`だけから導出し、食い違いを起こさない。"""
    monkeypatch.setenv("FPS_LIMIT_TARGET_HZ", "180")
    assert make_config().build_env()["SPEED_HACK_MULTIPLIER"] == "3"


def test_build_env_does_not_set_the_speed_hack_multiplier_for_slow_motion(monkeypatch):
    monkeypatch.setenv("FPS_LIMIT_TARGET_HZ", "30")
    monkeypatch.setenv("SPEED_HACK_MULTIPLIER", "2")  # 紛れ込んだ値も消す
    assert "SPEED_HACK_MULTIPLIER" not in make_config().build_env()


def test_build_env_sets_the_sync_marker_trigger_as_a_windows_path(monkeypatch):
    monkeypatch.delenv("FPS_LIMIT_TARGET_HZ", raising=False)
    assert make_config().build_env()["SYNC_MARKER_TRIGGER"] == "Z:\\instance\\sync_marker.trigger"


def test_runtime_overrides_leave_a_normal_cpu_job_untouched():
    config = make_config(extra_dlls=("vpatch_th06.dll",))
    assert with_runtime_overrides(config, {}, log=lambda msg: None) is config


def test_runtime_overrides_switch_to_gpu_display_on_a_gpu_worker():
    config = with_runtime_overrides(make_config(), {"GPU_WORKER": "1"}, log=lambda msg: None)

    assert config.gpu_display is True
    # GPU描画面では終了検知用のポーリングを本番キャプチャから分岐させる(reports/81・89)。
    assert config.poll_side_stream is True


def test_runtime_overrides_rewrite_vpatch_game_fps_for_speedup():
    config = make_config(
        extra_dlls=("vpatch_th10.dll",),
        vpatch_ini_overrides=(("Option", "BugFixTh10Power3", "1"),),
    )
    config = with_runtime_overrides(config, {"FPS_LIMIT_TARGET_HZ": "120"}, log=lambda msg: None)

    assert config.vpatch_ini_overrides == (
        ("Option", "BugFixTh10Power3", "1"),
        ("Option", "GameFPS", "120"),
        ("Option", "CalcFPS", "0"),
    )


def test_runtime_overrides_do_not_touch_vpatch_for_slow_motion_or_titles_without_vpatch():
    with_vpatch = make_config(extra_dlls=("vpatch_th06.dll",))
    assert with_runtime_overrides(with_vpatch, {"FPS_LIMIT_TARGET_HZ": "30"}, log=lambda m: None) is with_vpatch
    without = make_config()
    assert with_runtime_overrides(without, {"FPS_LIMIT_TARGET_HZ": "120"}, log=lambda m: None) is without
