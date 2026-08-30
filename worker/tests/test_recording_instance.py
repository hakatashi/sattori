"""instance ディレクトリの準備と、注入コマンドの組み立て。"""

from recording import instance
from recording_helpers import make_config


def test_build_injector_cmd_without_extra_dlls():
    config = make_config()

    cmd = instance.build_injector_cmd(config)

    assert cmd == ["wine", "injector.exe", "th08.exe", "th08_hook.dll"]


def test_build_injector_cmd_injects_extra_dlls_before_hook_dll():
    # th06のVsyncPatch(vpatch_th06.dll)はwined3dの白画面ハングを避けるため、
    # MOD本体(hook_dll)より前に注入されなければならない(touhou-recorder reports/30)。
    config = make_config(game_id="th06", extra_dlls=("vpatch_th06.dll",))

    cmd = instance.build_injector_cmd(config)

    assert cmd == ["wine", "injector.exe", "th06.exe", "vpatch_th06.dll", "th06_hook.dll"]


def test_resolve_appdata_dir_uses_the_running_unix_user(monkeypatch):
    """資産アーカイブを作った開発機のユーザー名ではなく、実行中のユーザーで解決する。

    Wineはプロファイルを`drive_c/users/<UNIXユーザー名>`にマッピングするため、
    ここを決め打ちにするとrootで動く本番コンテナがcfgを見つけられない
    (touhou-recorder reports/46 のバグ1と同じ症状)。
    """
    monkeypatch.setattr(instance.getpass, "getuser", lambda: "root")
    config = make_config(game_id="th20", wineprefix="/prefix/th20-wined3d-gl")

    assert instance.resolve_appdata_dir(config) == (
        "/prefix/th20-wined3d-gl/drive_c/users/root/AppData/Roaming/ShanghaiAlice/th20"
    )


def test_prepare_instance_places_cfg_and_replay_into_the_appdata_profile(tmp_path, monkeypatch):
    """th20(th125以降のエンジン)はゲーム本体ディレクトリではなく%APPDATA%を読む。"""
    monkeypatch.setattr(instance.getpass, "getuser", lambda: "root")
    game_dir = tmp_path / "games" / "th20"
    game_dir.mkdir(parents=True)
    (game_dir / "th20.cfg").write_bytes(b"cfg")
    (game_dir / "th20.exe").write_bytes(b"exe")
    replay = tmp_path / "upload.rpy"
    replay.write_bytes(b"replay")
    injector = tmp_path / "injector.exe"
    injector.write_bytes(b"i")
    hook = tmp_path / "th20_hook.dll"
    hook.write_bytes(b"h")

    config = make_config(
        game_id="th20",
        wineprefix=str(tmp_path / "prefix"),
        instance_dir=str(tmp_path / "instance"),
        game_dir_src=str(game_dir),
        canonical_slot="th20_ud0000.rpy",
        injector_path=str(injector),
        hook_dll_path=str(hook),
        uses_appdata_profile=True,
    )
    (tmp_path / "instance").mkdir()

    instance.prepare_instance(config, str(replay), log=lambda _m: None)

    appdata = tmp_path / "prefix/drive_c/users/root/AppData/Roaming/ShanghaiAlice/th20"
    assert (appdata / "th20.cfg").read_bytes() == b"cfg"
    assert (appdata / "replay/th20_ud0000.rpy").read_bytes() == b"replay"


def test_prepare_instance_clears_stale_replays_from_the_appdata_profile(tmp_path, monkeypatch):
    """MODは常に一覧の1件目を選ぶので、前回のリプレイが残っていると別物を録画する。"""
    monkeypatch.setattr(instance.getpass, "getuser", lambda: "root")
    game_dir = tmp_path / "games" / "th20"
    (game_dir / "replay").mkdir(parents=True)
    (game_dir / "th20.cfg").write_bytes(b"cfg")
    appdata = tmp_path / "prefix/drive_c/users/root/AppData/Roaming/ShanghaiAlice/th20"
    (appdata / "replay").mkdir(parents=True)
    (appdata / "replay/th20_ud9999.rpy").write_bytes(b"stale")
    replay = tmp_path / "upload.rpy"
    replay.write_bytes(b"replay")
    injector = tmp_path / "injector.exe"
    injector.write_bytes(b"i")
    hook = tmp_path / "th20_hook.dll"
    hook.write_bytes(b"h")

    config = make_config(
        game_id="th20",
        wineprefix=str(tmp_path / "prefix"),
        instance_dir=str(tmp_path / "instance"),
        game_dir_src=str(game_dir),
        canonical_slot="th20_ud0000.rpy",
        injector_path=str(injector),
        hook_dll_path=str(hook),
        uses_appdata_profile=True,
    )
    (tmp_path / "instance").mkdir()

    instance.prepare_instance(config, str(replay), log=lambda _m: None)

    assert sorted(p.name for p in (appdata / "replay").iterdir()) == ["th20_ud0000.rpy"]


def test_prepare_instance_skips_the_appdata_profile_for_other_titles(tmp_path, monkeypatch):
    monkeypatch.setattr(instance.getpass, "getuser", lambda: "root")
    game_dir = tmp_path / "games" / "th11"
    game_dir.mkdir(parents=True)
    replay = tmp_path / "upload.rpy"
    replay.write_bytes(b"replay")
    injector = tmp_path / "injector.exe"
    injector.write_bytes(b"i")
    hook = tmp_path / "th11_hook.dll"
    hook.write_bytes(b"h")

    config = make_config(
        game_id="th11",
        wineprefix=str(tmp_path / "prefix"),
        instance_dir=str(tmp_path / "instance"),
        game_dir_src=str(game_dir),
        canonical_slot="th11_ud0000.rpy",
        injector_path=str(injector),
        hook_dll_path=str(hook),
    )
    (tmp_path / "instance").mkdir()

    instance.prepare_instance(config, str(replay), log=lambda _m: None)

    assert not (tmp_path / "prefix").exists()


def test_apply_vpatch_ini_overrides_rewrites_key_and_keeps_others(tmp_path):
    ini = tmp_path / "vpatch.ini"
    ini.write_text("[Window]\nenabled = 0\n\n[Option]\nVsync = 0\nBugFixTh10Power3 = 1\n")

    instance.apply_vpatch_ini_overrides(str(ini), (("Option", "BugFixTh10Power3", "0"),), log=lambda _m: None)

    parser = instance.configparser.ConfigParser()
    parser.optionxform = str
    parser.read(ini)
    # 上書き対象以外のキー・セクションは保持される。
    assert parser.get("Window", "enabled") == "0"
    assert parser.get("Option", "Vsync") == "0"
    # キャメルケースのキー名が小文字化されずに保たれる。
    assert parser.get("Option", "BugFixTh10Power3") == "0"


def test_apply_vpatch_ini_overrides_creates_missing_section(tmp_path):
    ini = tmp_path / "vpatch.ini"
    ini.write_text("[Window]\nenabled = 0\n")

    instance.apply_vpatch_ini_overrides(str(ini), (("Option", "BugFixTh10Power3", "1"),), log=lambda _m: None)

    parser = instance.configparser.ConfigParser()
    parser.optionxform = str
    parser.read(ini)
    assert parser.get("Option", "BugFixTh10Power3") == "1"


def test_prepare_instance_applies_vpatch_ini_overrides(tmp_path):
    game_dir = tmp_path / "games" / "th10"
    game_dir.mkdir(parents=True)
    (game_dir / "vpatch.ini").write_text("[Option]\nBugFixTh10Power3 = 1\n")
    replay = tmp_path / "upload.rpy"
    replay.write_bytes(b"replay")
    injector = tmp_path / "injector.exe"
    injector.write_bytes(b"i")
    hook = tmp_path / "th10_hook.dll"
    hook.write_bytes(b"h")

    config = make_config(
        game_id="th10",
        wineprefix=str(tmp_path / "prefix"),
        instance_dir=str(tmp_path / "instance"),
        game_dir_src=str(game_dir),
        canonical_slot="th10_01.rpy",
        injector_path=str(injector),
        hook_dll_path=str(hook),
        vpatch_ini_overrides=(("Option", "BugFixTh10Power3", "0"),),
    )
    (tmp_path / "instance").mkdir()

    instance.prepare_instance(config, str(replay), log=lambda _m: None)

    parser = instance.configparser.ConfigParser()
    parser.optionxform = str
    parser.read(tmp_path / "instance" / "vpatch.ini")
    assert parser.get("Option", "BugFixTh10Power3") == "0"


def test_prepare_instance_skips_vpatch_ini_rewrite_when_no_overrides(tmp_path):
    """既定(overridesなし)では同梱のvpatch.iniをそのまま使う(他タイトルへの影響なし)。"""
    game_dir = tmp_path / "games" / "th11"
    game_dir.mkdir(parents=True)
    replay = tmp_path / "upload.rpy"
    replay.write_bytes(b"replay")
    injector = tmp_path / "injector.exe"
    injector.write_bytes(b"i")
    hook = tmp_path / "th11_hook.dll"
    hook.write_bytes(b"h")

    config = make_config(
        game_id="th11",
        wineprefix=str(tmp_path / "prefix"),
        instance_dir=str(tmp_path / "instance"),
        game_dir_src=str(game_dir),
        canonical_slot="th11_ud0000.rpy",
        injector_path=str(injector),
        hook_dll_path=str(hook),
    )
    (tmp_path / "instance").mkdir()

    instance.prepare_instance(config, str(replay), log=lambda _m: None)

    assert not (tmp_path / "instance" / "vpatch.ini").exists()
