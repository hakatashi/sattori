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

