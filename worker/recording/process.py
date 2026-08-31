"""ゲームプロセスの探索・thprac のアタッチ・Wine の後片付け。"""
import os
import signal
import subprocess
import time


# thpracのアタッチ(attach_thprac()、th20のみ。reports/50)の待ち時間。実測では
# 引数なしの`--attach`は0.4〜1.0秒で正常終了する(対象が見つからず空振りで終わる場合
# でも0.37秒かかる。Issue #110の実測)。低速録画でも伸ばす必要はない
# (アタッチはゲーム内時間に依存しない一回限りの外部プロセス実行のため)。
#
# **この予算は小さく保つこと**。アタッチは録画(ffmpeg)開始より前に行われ、猶予は
# MOD側のタイトルロゴ待ち(th20は10秒、低速録画なら20秒)しかない。ここで長く待つと
# 録画開始が遅れて**リプレイ冒頭を取りこぼす**が、それを検知する仕組みは無い
# (重複フレーム率も画面静止検知も冒頭の欠落は捕まえられない)。旧実装はthpracが
# 確認ダイアログを出したまま常駐した場合に60秒待つ作りになっていた(Issue #110)。
THPRAC_ATTACH_TIMEOUT_SEC = 10.0
# アタッチの試行回数。ゲーム起動直後はWindows側から「動いている東方ゲーム」として
# 認識できるようになるまでに揺らぎがあり、1回目が空振りすることがある(Issue #110)。
THPRAC_ATTACH_ATTEMPTS = 3
# thpracプロセスの終了後、/proc/<pid>/mapsにイメージが現れるまで待つ猶予。
# 終了直後に1回だけ読む一発勝負にすると、注入がわずかに遅れただけで失敗と記録される。
THPRAC_ATTACH_CONFIRM_SEC = 3.0


def find_live_game_pid(process_name):
    """process_nameのPIDのうち、zombie(状態Z)ではないものを1つ返す(なければNone)。
    コンテナ内ではPID 1(entrypoint.py)がinitのように孤児プロセスをreapする仕組みを
    持たないため、前の試行でSIGKILLしたプロセスがzombieのまま残り続けることがある。
    `pgrep -x`はzombieもマッチしてしまうため、2回目以降の試行で新しいプロセスでは
    なく前回のzombieのPIDを掴んでしまい、ウィンドウが永遠に見つからない原因になって
    いた(reports/24)。呼び出し側は`config.game_exe`(実際に起動するファイル名)ではなく
    `config.process_name`(pgrep/pkill専用。`/proc/PID/comm`の15バイト切り詰め対策、
    th06の`東方紅魔郷.exe`→`東方紅魔郷`、touhou-recorder reports/31参照)を渡すこと。"""
    out = subprocess.run(["pgrep", "-x", process_name], capture_output=True, text=True).stdout.split()
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


def thprac_attached(pid, thprac_exe):
    """指定PIDのプロセスにthpracのイメージがマップ済みかを /proc/<pid>/maps で確認する。

    thpracは自分自身のexeイメージを対象プロセスへ注入するため、アタッチが成功すると
    ゲームプロセスのマップにthpracのexeが現れる(reports/50)。"""
    try:
        with open(f"/proc/{pid}/maps") as f:
            return thprac_exe in f.read()
    except OSError:
        return False


def wait_for_thprac_attached(config, timeout=THPRAC_ATTACH_CONFIRM_SEC, poll_interval=0.2):
    """ゲームプロセスにthpracのイメージが現れるまで待ち、現れたらそのPIDを返す。

    thpracプロセスの終了直後に1回だけ`/proc/<pid>/maps`を読む一発勝負にしていたところ、
    実際にはアタッチできていた可能性を潰せなかった(Issue #110)。注入はthprac自身の
    終了とは非同期に完了しうるので、短い猶予を持ってポーリングする。"""
    t0 = time.time()
    while True:
        pid = find_live_game_pid(config.process_name)
        if pid and thprac_attached(pid, config.thprac_exe):
            return pid
        if time.time() - t0 >= timeout:
            return None
        time.sleep(poll_interval)


def attach_thprac(config, env, timeout=THPRAC_ATTACH_TIMEOUT_SEC,
                  attempts=THPRAC_ATTACH_ATTEMPTS,
                  confirm_timeout=THPRAC_ATTACH_CONFIRM_SEC, log=print):
    """起動直後のゲームプロセスにthprac(config.thprac_exe)をアタッチする(reports/50)。

    injector.exeが`CREATE_SUSPENDED`でゲームを起動して自作MODを注入する既存の経路は
    一切変えず、**起動後に後付けでアタッチする**方式を採っている。thprac側に
    ゲームを起動させるとMODの注入タイミング(DirectInput8Create呼び出し前のIATフック)が
    崩れるため。th20はタイトルロゴアニメーションだけで10秒待つので、アタッチが
    数秒遅れても操作シーケンスには十分間に合う。

    **呼び出しはゲームウィンドウが出現した後に行うこと**。PIDが生えた直後はゲームが
    まだ`CREATE_SUSPENDED`のままで、Windows側からは「動いている東方ゲーム」として
    成立していない。本番でこのレースに負けてアタッチが失敗した実例がある(Issue #110)。
    それでも稀に空振りしうるので、`attempts`回まで試行する。

    thpracの出力と終了コードは必ずログへ残す(旧実装は`DEVNULL`へ捨てており、失敗時に
    thprac自身が何を言っていたのか事後に分からなかった。同Issue)。

    `--attach` にPIDを渡さないのは、pgrepで得られるのはLinuxのPIDであり、Wineが
    ゲームプロセスに割り当てるWindows側のPIDとは別物だからである(LinuxのPIDを渡すと
    該当プロセスが見つからず、Xvfb上では誰も閉じられない確認ダイアログを出したまま
    thpracが常駐して固まる)。引数なしの`--attach`は「最初に見つかった東方ゲームの
    プロセス」へ自動でアタッチする。

    **同一WINEPREFIXで複数の東方ゲームを同時に走らせるとアタッチ先が不定になる**点に
    注意。Sattoriのワーカーは1コンテナ=1ジョブで、自宅ワーカーの並列録画も
    コンテナごとにWINEPREFIXが分かれる(=Windows側のプロセス列挙も分離される)ため、
    現状の構成では競合しない。

    戻り値: アタッチに成功したら True。失敗しても録画自体は続行できる(thpracなしの
    従来動作に戻るだけ)ため、呼び出し側は False を失敗として扱わないこと。"""
    if not config.thprac_exe:
        return False
    thprac_path = f"{config.instance_dir}/{config.thprac_exe}"
    if not os.path.exists(thprac_path):
        # タイトル資産アーカイブの作り忘れをここで診断できるようにしておく。
        log(f"WARNING: {thprac_path} が見つかりません。thprac無しで録画します"
            "(th20はデシンクが起きやすくなります、reports/50)")
        return False

    t0 = time.time()
    for attempt in range(1, attempts + 1):
        log(f"thprac をアタッチします ({config.thprac_exe}, 試行 {attempt}/{attempts})")
        proc = subprocess.Popen(
            ["wine", config.thprac_exe, "--attach"],
            cwd=config.instance_dir, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        try:
            out, _ = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            # Xvfb上では誰も閉じられない確認ダイアログを出したまま常駐している可能性が
            # 高い(reports/50)。同じ状態を積み増すだけなのでリトライはしない。
            proc.kill()
            out, _ = proc.communicate()
            log(f"WARNING: thprac のアタッチが{timeout}秒でタイムアウトしました。"
                "thprac無しで録画します")
            log_thprac_output(out, log)
            return False
        log(f"thprac 終了 (exit={proc.returncode}, {time.time()-t0:.1f}s)")
        log_thprac_output(out, log)

        pid = wait_for_thprac_attached(config, timeout=confirm_timeout)
        if pid:
            log(f"thprac アタッチ完了 ({time.time()-t0:.1f}s, pid={pid})")
            return True
        log(f"WARNING: thprac のイメージがゲームプロセスにマップされていません"
            f"(試行 {attempt}/{attempts})")
    log("WARNING: thprac をアタッチできませんでした。thprac無しで録画します"
        "(th20はデシンクが起きやすくなります、reports/50・Issue #110)")
    return False


def log_thprac_output(out, log):
    """thpracプロセスの出力を1行ずつワーカーログへ流す(Issue #110)。

    普段は無出力だが、アタッチが失敗したときにthprac自身が何を言っていたのかを
    事後に確認できるかどうかが原因究明を分ける。"""
    for line in (out or "").splitlines():
        if line.strip():
            log(f"thprac出力: {line.rstrip()}")


def _find_pids_with_wineprefix(wineprefix):
    """指定WINEPREFIXで動作中の全プロセスのPIDを`/proc`から洗い出す。
    プロセス名でのpkillは並列録画中の他インスタンス(同名の別WINEPREFIX、reports/33)まで
    巻き込みかねないため、各プロセスの環境変数WINEPREFIXで対象を絞り込む。"""
    target = f"WINEPREFIX={wineprefix}".encode()
    pids = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/environ", "rb") as f:
                environ = f.read()
        except OSError:
            # プロセスがこの読み取り中に終了しただけの正常なレース。
            continue
        if target in environ.split(b"\0"):
            pids.append(int(entry))
    return pids


def kill_wine_and_wait(config, env, process_name, log=print):
    """ゲーム本体とwineserverを終了させ、実際にwineserverが終了するまで待つ。
    固定sleepで待っていたところ、AWSのようにCPUが逼迫した環境ではwineserverの
    終了処理自体に2秒以上かかることがあり、終了前に次の試行のinjectorを起動して
    ウィンドウ検出に失敗する事象が確認された(reports/24)。`wineserver -w`は
    現在起動中のwineserverが実際に終了するまでブロックするため、固定時間の
    推測より確実。呼び出し側は`config.process_name`を渡すこと(find_live_game_pid()参照)。

    ゲームプロセスがGPU待ち等でD state(カーネルレベルで割り込み不可能)に陥っていると
    `wineserver -k`のシグナルが効かず、`-w`が60秒待っても終了を確認できないことがある
    (2026-08-27、ホストのsystem D-Busメッセージキュー枯渇インシデント。放置された
    winedevice.exeがsystem D-Busの購読を持ったまま残り続けたのが一因)。その場合は
    諦めてこのWINEPREFIX配下に残る全プロセスをSIGKILLする。ここで例外にせず必ず
    後片付けを完結させないと、呼び出し元(リトライループ)が例外で中断した際に
    wineserver/winedeviceがホストに無期限に取り残されてしまう。"""
    subprocess.run(["pkill", "-9", "-x", process_name])
    subprocess.run(["wineserver", "-k"], env=env)
    try:
        subprocess.run(["wineserver", "-w"], env=env, timeout=60)
    except subprocess.TimeoutExpired:
        leftover_pids = _find_pids_with_wineprefix(config.wineprefix)
        log(
            f"WARNING: wineserver -w が60秒でタイムアウトしました(wineprefix={config.wineprefix})。"
            f"残存プロセスをSIGKILLします: {leftover_pids}"
        )
        for pid in leftover_pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                # ProcessLookupError(通常のプロセス終了とのレース)に加え、権限エラー等
                # 想定外のOSErrorでもこの後片付けループ全体を中断させない。
                pass
