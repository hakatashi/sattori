"""録画用の使い捨て環境(Xディスプレイ + instanceディレクトリ)の準備。

instanceディレクトリは「ゲーム本体をrsyncでコピーし、対象リプレイ1件とMOD DLLだけを
置いた」作業用ディレクトリ。`games/`配下の原本を汚さないためと、並列実行時に
WINEPREFIXとゲームディレクトリをインスタンスごとに分離する(共有すると固まる・壊れる)
ためにこの形をとっている。
"""
import os
import re
import subprocess
import time

from .config import DOUBLESPEED_SINK_NAME_PREFIX, REPO, XVFB_SCREEN
from .log import log
from .timing import AUDIO_CAPTURE_RATE_HZ, MENU_TIME_SCALE, NATIVE_AUDIO_RATE_HZ, NATIVE_FRAME_RATE_HZ


def ensure_display(config, env):
    """録画先のXディスプレイを用意する(既に起動済みなら再利用する)。"""
    check = subprocess.run(["xdotool", "search", "--name", "."], env=env, capture_output=True)
    if check.returncode == 0:
        log(f"Xvfb {config.display} は起動済みとみなして再利用します")
        return
    if config.gpu_display:
        _start_gpu_display(config)
        return
    _start_xvfb(config, env)


def _doublespeed_sink_name(config):
    return f"{DOUBLESPEED_SINK_NAME_PREFIX}_{config.game_id}"


def _pactl(args, env, check=False):
    """pactlを**必ずCロケールで**実行する。

    `GameConfig.build_env()`はゲームの日本語表示のため`LANG=ja_JP.UTF-8`等を
    設定しており、そのままpactlに渡すと出力ラベルまで翻訳される
    (`Name:`→`名前:`、`Owner Module:`→`所有者モジュール:`)。英語ラベル前提の
    パースが静かに失敗し、シンクの削除・再作成が行われないまま通り過ぎる不具合が
    ローカル実機で発覚した(reports/86)。
    """
    lc_env = dict(env)
    lc_env["LC_ALL"] = "C"
    lc_env.pop("LANGUAGE", None)
    return subprocess.run(["pactl"] + args, env=lc_env, capture_output=True, text=True, check=check)


def _find_sink_owner_module(sink_name, env):
    """シンク名から、それをロードしたモジュールのIDを引く(見つからなければNone)。

    `pactl list short sinks`の1列目は「シンクインデックス」であって
    unload-moduleが要求する「モジュールインデックス」ではない(別の名前空間、
    実機で誤って渡すとCalledProcessErrorになるバグとして発覚、reports/85)。
    `pactl list sinks`(詳細)の"Owner Module:"から正しいIDを取得する。
    """
    detail = _pactl(["list", "sinks"], env)
    in_block = False
    for line in detail.stdout.splitlines():
        s = line.strip()
        if s.startswith("Name:"):
            in_block = (s == f"Name: {sink_name}")
        elif in_block and s.startswith("Owner Module:"):
            return s.split(":", 1)[1].strip()
    return None


def remove_audio_sink(config, env):
    """`ensure_audio_sink()`が作った倍速録画用シンクを後片付けする。

    **これを怠ると同じホストでの以後のネイティブ/低速録画がすべて壊れる。**
    PulseAudioの`module-always-sink`は「他にシンクが1つも無いとき」だけダミーの
    `auto_null`を生やす仕様のため、倍速録画用シンクが残っているとauto_nullが
    消えたままになり、`recorder/config.py`の`PULSE_SOURCE`(`auto_null.monitor`)を
    開けずに音声録音が失敗する(ローカル実機で再現、reports/86)。AWSでは
    ジョブごとに使い捨てコンテナを立てるため表面化していなかった。
    """
    if AUDIO_CAPTURE_RATE_HZ == NATIVE_AUDIO_RATE_HZ:
        return
    sink_name = _doublespeed_sink_name(config)
    module_id = _find_sink_owner_module(sink_name, env)
    if not module_id:
        log(f"WARNING: PulseAudioシンク {sink_name} のモジュールIDを特定できず削除をスキップしました")
        return
    r = _pactl(["unload-module", module_id], env)
    if r.returncode == 0:
        log(f"倍速録画用PulseAudioシンク {sink_name} を削除しました")
    else:
        log(f"WARNING: PulseAudioシンク {sink_name} の削除に失敗しました: {r.stderr.strip()}")


def ensure_audio_sink(config, env):
    """倍速録画時、ナイキスト周波数を確保するための高レート専用PulseAudioシンクを
    用意する(reports/85)。ネイティブ/低速録画時は何もしない(既定のauto_nullのまま)。

    `GameConfig.build_env()`が`PULSE_SINK`環境変数をこのシンク名に設定しており、
    ゲームの音声出力(wineのPulseAudioドライバ)は自動的にこのシンクへ流れる。
    録音側(`recorder/ffmpeg.py`)は`{sink_name}.monitor`から読む。

    このシンクのレートがそのままWineのWASAPIミックスフォーマットになり、
    dsoundのミキサーがセカンダリバッファをリサンプルする先のレートになる
    (`dlls/dsound/mixer.c`の`freqAdjustDen`)。ここが倍速後のレートに足りないと
    ミキサー内部のアンチエイリアスLPFで高域が落とされ、録音側でいくら
    サンプルレートを上げても取り返せない(reports/86 §2)。

    後片付けは`remove_audio_sink()`が行う(呼び忘れると以後のネイティブ録画が壊れる)。
    """
    if AUDIO_CAPTURE_RATE_HZ == NATIVE_AUDIO_RATE_HZ:
        return
    sink_name = _doublespeed_sink_name(config)
    check = _pactl(["list", "short", "sinks"], env)
    for line in check.stdout.splitlines():
        cols = line.split("\t")
        if len(cols) >= 4 and cols[1] == sink_name:
            if f"{AUDIO_CAPTURE_RATE_HZ}Hz" in cols[3]:
                log(f"PulseAudioシンク {sink_name} ({AUDIO_CAPTURE_RATE_HZ}Hz) は既に存在するため再利用します")
                return
            log(f"PulseAudioシンク {sink_name} のレートが古い({cols[3]})ため再作成します")
            module_id = _find_sink_owner_module(sink_name, env)
            if module_id:
                _pactl(["unload-module", module_id], env, check=True)
            break
    r = _pactl(
        ["load-module", "module-null-sink", f"sink_name={sink_name}",
         f"rate={AUDIO_CAPTURE_RATE_HZ}", "channels=2"], env,
    )
    if r.returncode != 0:
        raise RuntimeError(f"PulseAudioシンク {sink_name} の作成に失敗しました: {r.stderr}")
    log(f"倍速録画用PulseAudioシンク {sink_name} (rate={AUDIO_CAPTURE_RATE_HZ}) を作成しました")


def _start_gpu_display(config):
    """th06ncのようにソフトウェア描画では60fpsに届かないタイトル用のGPU描画面。

    Xvfb は DRI3 拡張を持たずハードウェア描画ができないため、代わりに
    headless weston(--renderer=gl) + rootful Xwayland + openbox を立てる。
    rootfulにするのが要点で、rootless Xwaylandではルートウィンドウに描画内容が
    compositeされず x11grab が黒画面になる(reports/78 §6)。
    """
    screen_wh = "x".join(config.xvfb_screen.split("x")[:2])
    log(f"GPU描画面 {config.display} ({screen_wh}) を起動します")
    r = subprocess.run(
        [f"{REPO}/scripts/78_start_gpu_display.sh",
         "--display", config.display, "--screen", screen_wh]
        # xorgバックエンドでのプライマリ出力の表示モード。th06ncのように「モニタのモード」を
        # 見てウィンドウ解像度を決めるタイトルで必要(未指定ならCRTCは1024x768のまま。reports/81)。
        + (["--crtc-mode", config.crtc_mode] if config.crtc_mode else []),
        capture_output=True, text=True,
    )
    for line in (r.stdout + r.stderr).splitlines():
        log(f"  [gpu_display] {line}")
    if r.returncode != 0:
        raise RuntimeError(f"GPU描画面 {config.display} の起動に失敗しました")


def _start_xvfb(config, env):
    log(f"Xvfb {config.display} を起動します")
    subprocess.Popen(
        ["Xvfb", config.display, "-screen", "0", config.xvfb_screen or XVFB_SCREEN],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(1.5)
    subprocess.Popen(
        ["openbox", "--sm-disable"], env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(1.0)


def prepare_instance(config, replay_filename, frame_sync=False):
    """instanceディレクトリを作り直し、対象リプレイ1件とMOD一式を配置する。

    リプレイを1件だけにするのは、MODのキーシーケンスが「リプレイ一覧の特定スロットを選ぶ」
    固定手順であり、余計なリプレイが並んでいると別のリプレイを再生してしまうため。
    配置先ファイル名は`replay_dest_filename`で正規化できる。
    """
    instance_dir = config.instance_dir
    subprocess.run(
        ["rsync", "-a", "--exclude=replay", f"{config.game_dir_src}/", f"{instance_dir}/"], check=True
    )
    _apply_vpatch_game_fps(config, frame_sync=frame_sync)
    os.makedirs(f"{instance_dir}/replay", exist_ok=True)
    for f in os.listdir(f"{instance_dir}/replay"):
        os.remove(f"{instance_dir}/replay/{f}")
    dest_name = config.replay_dest_filename or replay_filename
    subprocess.run(
        ["cp", f"{config.game_dir_src}/replay/{replay_filename}", f"{instance_dir}/replay/{dest_name}"],
        check=True,
    )
    subprocess.run(
        ["cp", f"{REPO}/mods/common/build/{config.injector}", instance_dir], check=True
    )
    subprocess.run(["cp", config.hook_dll_src, instance_dir], check=True)
    # rsync後に上書きしたいファイル(th06cのSteamworks APIスタブ等)。
    # (コピー元パス, インスタンスディレクトリ内でのファイル名) のリスト。
    for src, name in config.extra_files:
        subprocess.run(["cp", src, f"{instance_dir}/{name}"], check=True)
        log(f"{name} を上書き配置しました ({src})")
    _prepare_appdata(config, replay_filename, dest_name)
    if os.path.exists(config.log_path):
        os.remove(config.log_path)
    log(f"instance ディレクトリ準備完了 (replay={replay_filename} のみ配置)")


def _apply_vpatch_game_fps(config, frame_sync=False):
    """VsyncPatch(vpatch_*.dll)を注入するタイトル(th06/th10)で、倍速・低速録画時に
    vpatch.ini の GameFPS を FPS_LIMIT_TARGET_HZ 相当へ書き換える(reports/89)。

    vpatchを注入したth06のフレームレートはvpatch自身のタイマーが決めており、
    MODのQPC偽装(speed_hack_hook)はexeのIATにしか効かないためvpatch内部の待ちには
    届かない。vpatch本来の設定値で直接ゲームfpsを変える。

    あわせて、等倍以外やフレーム同期キャプチャ時は CalcFPS を 0 にする(reports/90)。
    CalcFPS=1 だとvpatchが画面上のfps表示を自前の実時間タイマーで計算するため、
    2倍速や可変速録画で異常値が出る。0 にするとゲーム本来のfps計算に戻り、MOD側の
    偽装(th10はspeed_hack_hookのQPCや仮想時計、th06はfps_display_hookのtimeGetTime等)
    が効いて等倍換算の値が表示される。"""
    if not any(d.lower().startswith("vpatch_") for d in config.extra_dlls):
        return
    ini = f"{config.instance_dir}/vpatch.ini"
    if not os.path.exists(ini):
        return
    fps = round(NATIVE_FRAME_RATE_HZ / MENU_TIME_SCALE)
    with open(ini, "rb") as f:
        data = f.read()
    new = re.sub(rb"(?m)^GameFPS\s*=\s*\d+", b"GameFPS = %d" % fps, data)
    calc_fps = 0 if (frame_sync or fps != NATIVE_FRAME_RATE_HZ) else 1
    new = re.sub(rb"(?m)^CalcFPS\s*=\s*\d+", b"CalcFPS = %d" % calc_fps, new)
    if new != data:
        with open(ini, "wb") as f:
            f.write(new)
    log(f"vpatch.ini の GameFPS を {fps}、CalcFPS を {calc_fps} に設定しました")


def _prepare_appdata(config, replay_filename, dest_name):
    """th125以降のエンジン(th128/th15/th20)向けに%APPDATA%側へもcfg/replayを配置する。

    これらのタイトルはcfg/replayをゲーム本体ディレクトリではなくWINEPREFIX側の
    %APPDATA%/ShanghaiAlice/<title>/から読み込む仕様のため、instanceディレクトリへの
    配置だけではゲームに読まれない(reports/44)。instance_dir側への配置は他タイトルと
    処理を共通化するために残してあるが、これらのタイトルでは使われない。
    """
    appdata_dir = config.appdata_dir
    if not appdata_dir:
        return
    os.makedirs(f"{appdata_dir}/replay", exist_ok=True)
    for f in os.listdir(f"{appdata_dir}/replay"):
        os.remove(f"{appdata_dir}/replay/{f}")
    subprocess.run(
        ["cp", f"{config.game_dir_src}/replay/{replay_filename}", f"{appdata_dir}/replay/{dest_name}"],
        check=True,
    )
    if config.cfg_filename:
        # GAME_CFG_OVERRIDE: 検証用に別のcfgを使う(例: th15の画面サイズを960x720にしたcfg、reports/99)
        cfg_src = os.environ.get("GAME_CFG_OVERRIDE") or f"{config.game_dir_src}/{config.cfg_filename}"
        subprocess.run(
            ["cp", cfg_src,
             f"{appdata_dir}/{config.cfg_filename}"],
            check=True,
        )
    log(f"AppData配下にもcfg/replayを配置しました ({appdata_dir})")


def build_injector_cmd(config):
    """MOD DLLを注入してゲームを起動するコマンドを組み立てる。

    `extra_dlls`(th06/th10のVsyncPatch等)はMOD本体より**前**に並べること。th06では
    wined3dの白画面ハング(reports/30)を回避するため、VsyncPatchを先に注入する必要がある。
    """
    dll_args = list(config.extra_dlls) + [config.hook_dll]
    return ["wine", config.injector, config.game_exe, *dll_args], dll_args
