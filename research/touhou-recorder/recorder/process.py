"""ゲームプロセスの探索・thpracのアタッチ・Wineの後片付け。

**`kill_wine_and_wait()`は必ずtry/finallyから呼ぶこと。** 録画処理のどこで例外・
タイムアウト・外部シグナルが発生してもwineserver/winedeviceが放置されないことを
保証しないと、ホストのsystem D-Busのメッセージキューが枯渇してシステム全体の
ハングを引き起こす(reports/55)。
"""
import os
import signal
import subprocess
import time

from .log import log


def find_live_game_pid(config):
    """ゲーム本体のPIDのうちzombie(状態Z)ではないものを1つ返す(なければNone)。

    コンテナ内ではPID 1(entrypoint.py)がinitのように孤児プロセスをreapする仕組みを
    持たないため、前の試行でSIGKILLしたゲームプロセスがzombieのまま残り続けることが
    あり、2回目以降の試行で新しいプロセスではなく前回のzombieのPIDを掴んでしまう
    (reports/24)。
    """
    out = subprocess.run(
        ["pgrep", "-x", config.process_name], capture_output=True, text=True
    ).stdout.split()
    for pid in out:
        try:
            with open(f"/proc/{pid}/stat") as f:
                stat = f.read()
            state = stat.rsplit(") ", 1)[-1].split()[0]
        except FileNotFoundError:
            continue
        if state != "Z":
            return pid
    return None


def wait_for_game_pid(config, timeout=20):
    """ゲームプロセスが現れるまで待つ。戻り値は (pid, 所要秒)。見つからなければ (None, 所要秒)。"""
    t0 = time.time()
    while time.time() - t0 < timeout:
        pid = find_live_game_pid(config)
        if pid:
            return pid, time.time() - t0
        time.sleep(0.1)
    return None, time.time() - t0


def find_pids_for_wineprefix(wineprefix):
    """指定WINEPREFIXの環境変数を持つプロセスのPID一覧を返す。

    game_exeやwineserver自体だけでは、winedevice.exe等のWineが内部生成する子プロセスを
    個別には捕捉できない。`wineserver -w`がタイムアウトした際のフォールバックとして、
    当該WINEPREFIX配下の全プロセスを直接SIGKILLするために使う(reports/55)。
    """
    pids = []
    target = f"WINEPREFIX={wineprefix}".encode()
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/environ", "rb") as f:
                environ = f.read()
        except OSError:
            continue
        if target in environ.split(b"\0"):
            pids.append(int(entry))
    return pids


def kill_wine_and_wait(config, env):
    """ゲームプロセスとwineserverを終了させ、実際にwineserverが終了するまで待つ。

    `wineserver -w`自体がタイムアウトした場合(ゲームプロセスがGPU待ち等でカーネル
    レベルで割り込み不可能な状態(D state)にあり`pkill -9`が即座に効かない場合など)に
    例外を伝播させて後片付け処理自体を止めてしまわないよう、ここでtimeoutを捕捉し、
    当該WINEPREFIX配下の残存プロセスを直接SIGKILLするフォールバックを行う。
    """
    subprocess.run(["pkill", "-9", "-x", config.process_name])
    subprocess.run(["wineserver", "-k"], env=env)
    try:
        subprocess.run(["wineserver", "-w"], env=env, timeout=60)
    except subprocess.TimeoutExpired:
        wineprefix = env.get("WINEPREFIX", "")
        log(
            f"WARNING: wineserver -w が60秒以内に終了しませんでした。"
            f"WINEPREFIX={wineprefix} 配下の残存プロセスをSIGKILLで強制終了します(reports/55参照)"
        )
        pids = find_pids_for_wineprefix(wineprefix) if wineprefix else []
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
                log(f"  PID {pid} をSIGKILLしました")
            except ProcessLookupError:
                pass
        if not pids:
            log("  WARNING: WINEPREFIXに紐づく残存プロセスが見つかりませんでした")


def thprac_attached(pid, thprac_exe):
    """指定PIDのプロセスにthpracのイメージがマップ済みかを /proc/<pid>/maps で確認する。

    thpracは自分自身のexeイメージを対象プロセスへ注入するため、アタッチが成功すると
    ゲームプロセスのマップにthpracのexeが現れる。
    """
    try:
        with open(f"/proc/{pid}/maps") as f:
            return thprac_exe in f.read()
    except OSError:
        return False


THPRAC_ATTACH_ATTEMPTS = 5
THPRAC_ATTACH_RETRY_INTERVAL_SEC = 1.0


def attach_thprac(config, env, timeout=60):
    """起動直後のゲームプロセスにthpracをアタッチする(reports/50)。

    `--attach`にPIDを渡さないのは、pgrepで得られるのはLinuxのPIDであり、Wineがゲーム
    プロセスに割り当てるWindows側のPIDとは別物だからである(LinuxのPIDを渡すと該当
    プロセスが見つからず、確認ダイアログが出たままthpracが常駐して固まる)。引数なしの
    `--attach`は「最初に見つかった東方ゲームのプロセス」に自動でアタッチするため、
    これを使う。

    注意: この仕様上、同一マシンで複数の東方ゲームを同時に走らせている場合は意図しない
    プロセスへアタッチしうる。並列録画と --thprac の併用は未検証。
    """
    thprac_exe = config.thprac_exe
    if not thprac_exe:
        log("WARNING: このタイトルには thprac_exe が設定されていないため --thprac を無視します")
        return False
    if not os.path.exists(f"{config.instance_dir}/{thprac_exe}"):
        log(f"WARNING: {thprac_exe} が instance ディレクトリに見つからないため --thprac を無視します")
        return False

    log(f"thprac をアタッチします ({thprac_exe})")
    t0 = time.time()
    # ゲームプロセス検出直後は `--attach` が対象を見つけられずすぐ終了することがある
    # (GPU描画面でのth128で3回連続失敗→thprac無しで再生が始まらず固まる事象、reports/89)。
    # マップへの反映を確認できるまで数回やり直す。
    for attempt in range(THPRAC_ATTACH_ATTEMPTS):
        if attempt:
            time.sleep(THPRAC_ATTACH_RETRY_INTERVAL_SEC)
        proc = subprocess.Popen(
            ["wine", thprac_exe, "--attach"],
            cwd=config.instance_dir, env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            log("ERROR: thprac のアタッチがタイムアウトしました")
            return False

        pid = find_live_game_pid(config)
        if pid and thprac_attached(pid, thprac_exe):
            log(f"thprac アタッチ完了 ({time.time()-t0:.1f}s, pid={pid}, 試行{attempt + 1}回目)")
            return True
        log(f"thprac のアタッチを確認できませんでした(試行{attempt + 1}/{THPRAC_ATTACH_ATTEMPTS})")
    log("ERROR: thprac のイメージがゲームプロセスにマップされていません(アタッチ失敗)")
    return False
