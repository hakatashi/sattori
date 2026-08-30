"""GameConfig の既定値の導出と、タイトルごとの上書き。"""

from recording import config
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
    # 白画面ハングが再発するため元のファイル名のまま使う(record_th06.pyのモジュール
    # docstring参照)。/proc/PID/commは15バイトで切り詰められるため、pgrep/pkill専用の
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


def test_game_config_end_template_path_defaults_next_to_module():
    # 未指定ならrecording_common.pyと同じディレクトリ配下のassets/replay_end_templates/
    # {game_id}.pngを既定値として使う(record_th0X.py側での明示指定は不要、reports/33・34)。
    config = make_config(game_id="th07")

    assert config.end_template_path.endswith("/assets/replay_end_templates/th07.png")


def test_game_config_allows_overriding_end_template_path():
    config = make_config(end_template_path="/custom/th08.png")

    assert config.end_template_path == "/custom/th08.png"


def test_game_config_thprac_exe_defaults_to_none():
    config = make_config()

    assert config.thprac_exe is None


# --- th20 向けの GameConfig 拡張(Issue #87) --------------------------------


def test_xvfb_screen_defaults_to_shared_value_and_can_be_overridden():
    assert make_config().xvfb_screen == config.XVFB_SCREEN
    assert make_config(xvfb_screen="1400x1100x24").xvfb_screen == "1400x1100x24"


def test_cfg_filename_defaults_to_game_id():
    assert make_config(game_id="th20").cfg_filename == "th20.cfg"
