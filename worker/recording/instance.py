"""録画1回ぶんの実行環境(Xvfb・instance ディレクトリ・注入コマンド)の準備。"""
import configparser
import getpass
import os
import subprocess
import time


def ensure_xvfb(config, env, log=print):
    check = subprocess.run(["xdotool", "search", "--name", "."], env=env, capture_output=True)
    if check.returncode == 0:
        log(f"Xvfb {config.display} は起動済みとみなして再利用します")
        return
    log(f"Xvfb {config.display} を起動します (screen={config.xvfb_screen})")
    subprocess.Popen(
        ["Xvfb", config.display, "-screen", "0", config.xvfb_screen],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(1.5)
    subprocess.Popen(
        ["openbox", "--sm-disable"], env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(1.0)


def resolve_appdata_dir(config):
    """th125以降のエンジン(th20)がcfg/リプレイを読む`%APPDATA%/ShanghaiAlice/{title}/`の
    実体パスを、**実行中のUNIXユーザーから**組み立てる。

    Wineはユーザープロファイルを`drive_c/users/<UNIXユーザー名>`にマッピングし、
    プレフィックスに無ければ起動時にそのユーザーぶんを新規作成する。したがって
    タイトル資産アーカイブに入っている`users/hakatashi/...`(アーカイブを作った開発機の
    ユーザー名)を決め打ちにすると、rootで動く本番コンテナは空の`users/root/`を
    参照してcfgを見つけられず、初回起動時の解像度選択ダイアログで止まる
    (touhou-recorder reports/46 のバグ1と同じ症状。あちらはコンテナのユーザー名を
    `hakatashi`へ改名して回避したが、こちらは**ユーザー名に依存しない**方を採る——
    ワーカーイメージの実行ユーザーと、資産アーカイブを作った開発機のユーザー名を
    一致させ続ける運用上の約束を増やしたくないため)。
    """
    return (
        f"{config.wineprefix}/drive_c/users/{getpass.getuser()}"
        f"/AppData/Roaming/ShanghaiAlice/{config.game_id}"
    )


def prepare_instance(config, replay_path, log=print):
    """ゲーム一式を instance ディレクトリへ複製し、録画対象リプレイだけを
    正規スロット名で replay/ 配下に配置する。extra_dlls(th06のvpatch_th06.dll等)は
    game_dir_src配下に同梱されている前提のため、以下のrsyncで自動的にコピーされる
    (個別のcpは不要)。

    `uses_appdata_profile`(th20)のタイトルは、ゲームが実際に読むのは instance
    ディレクトリではなく WINEPREFIX 側の `%APPDATA%` なので、cfg とリプレイを
    そちらにも配置する。instance 側への配置も残しておく——他タイトルと処理を
    共通化できるうえ、ゲームに読まれないだけで害が無いため。"""
    subprocess.run(
        ["rsync", "-a", "--exclude=replay", f"{config.game_dir_src}/", f"{config.instance_dir}/"],
        check=True,
    )
    replay_dir = f"{config.instance_dir}/replay"
    os.makedirs(replay_dir, exist_ok=True)
    for f in os.listdir(replay_dir):
        os.remove(f"{replay_dir}/{f}")
    subprocess.run(["cp", replay_path, f"{replay_dir}/{config.canonical_slot}"], check=True)
    subprocess.run(["cp", config.injector_path, config.instance_dir], check=True)
    subprocess.run(["cp", config.hook_dll_path, config.instance_dir], check=True)
    if config.uses_appdata_profile:
        appdata_dir = resolve_appdata_dir(config)
        appdata_replay_dir = f"{appdata_dir}/replay"
        os.makedirs(appdata_replay_dir, exist_ok=True)
        # 前回の録画で置いたリプレイが残っていると、ユーザーリプレイ一覧の1件目が
        # 今回の対象とは限らなくなる(MODは常に1件目を選ぶ)。必ず空にしてから置く。
        for f in os.listdir(appdata_replay_dir):
            os.remove(f"{appdata_replay_dir}/{f}")
        subprocess.run(
            ["cp", replay_path, f"{appdata_replay_dir}/{config.canonical_slot}"], check=True
        )
        cfg_src = f"{config.game_dir_src}/{config.cfg_filename}"
        if os.path.exists(cfg_src):
            subprocess.run(["cp", cfg_src, f"{appdata_dir}/{config.cfg_filename}"], check=True)
        else:
            # cfgが無いと初回起動時の解像度選択ダイアログが出てウィンドウ検出に失敗する。
            # 資産アーカイブの作り忘れをここで診断できるようにしておく(reports/44)。
            log(f"WARNING: {cfg_src} が見つかりません。初回起動ダイアログで停止する可能性があります")
        log(f"%APPDATA%配下にもcfg/リプレイを配置しました ({appdata_dir})")
    if config.vpatch_ini_overrides:
        apply_vpatch_ini_overrides(
            f"{config.instance_dir}/vpatch.ini", config.vpatch_ini_overrides, log=log,
        )
    if os.path.exists(config.log_path):
        os.remove(config.log_path)
    log(f"instance 準備完了 (対象リプレイを {config.canonical_slot} として配置)")


def apply_vpatch_ini_overrides(path, overrides, log=print):
    """VsyncPatch(vpatch.ini)の指定キーをジョブごとの値へ上書きする。他の設定は
    そのまま保持する(configparserは既定でキーを小文字化するため、vpatch.iniの
    キャメルケースキー(`BugFixTh10Power3`等)を保つためoptionxform=strを指定する)。
    """
    parser = configparser.ConfigParser()
    parser.optionxform = str
    parser.read(path)
    for section, key, value in overrides:
        if not parser.has_section(section):
            parser.add_section(section)
        parser.set(section, key, value)
        log(f"vpatch.ini上書き: [{section}] {key} = {value}")
    with open(path, "w") as f:
        parser.write(f)


def build_injector_cmd(config):
    """injector.exeへ渡す引数列を組み立てる。extra_dllsが指定されていれば
    hook_dllより前に指定順で注入させる(injector.exeは指定順に全DLLを注入してから
    メインスレッドを再開する、mods/common/injector.cpp参照)。"""
    return ["wine", config.injector, config.game_exe, *config.extra_dlls, config.hook_dll]
