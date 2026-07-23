"""th07/th08 共通の録画パイプライン処理(Sattori ワーカー)。

タイトル固有の差分(実行ファイル名・MOD DLL 名・WINEPREFIX 等)は `GameConfig` に
まとめ、Xvfb 起動・ウィンドウ検出・録画・終了検知・リトライといった手続き自体は
本モジュールに集約する(`record_th07.py` / `record_th08.py` はどちらも `GameConfig`
を組み立てて `record_with_retry()` を呼ぶだけの薄いラッパーになる)。

Issue #13(th08 対応)に伴う touhou-recorder での検証(reports/22〜26)で、
th07 では問題にならなかった以下2種の異常が th08 で高い確率(ver1.00a 時点で
th8_06.rpy は成功率20%)で発生することが分かった:

  - fps暴走: リプレイ再生中に内部fpsが数百〜数千に跳ね上がり、リプレイが
    実時間の数十分の一で終わってしまう(reports/22)。公式アップデータ
    ver1.00d への更新で事実上解消したが(reports/23)、稀な残存ケースへの
    備えとして検知ロジック自体は残す。
  - 処理落ち: 録画開始直後の外乱でx11grabのフレームタイミングが崩れ、
    以降ずっと重複フレームで埋まる(reports/12・13由来、th08でも発生を確認)。

これらの検知・自動リトライは th08 固有の対策として作られたものだが、
処理落ち自体は th07 の開発初期(reports/12・13)にも観測された現象であり、
リトライという保険自体を両タイトル共通の仕組みにしておいて損はないため、
本モジュールでは th07 に対しても同じ検知・リトライ経路を適用する
(th07 の MOD は FpsMonitor を組み込んでいないため、fps暴走判定は実質的に
発火しない)。既定のリトライ回数は3回(ユーザー判断。th08固有の不安定性は
ver1.00d更新+音声分離修正でおおむね解消された前提のため、旧検証時に推奨されて
いた8〜15回のような大きな値は採用しない)。

もう一つの th08 固有の発見(reports/26)は、x11grab(映像)とpulse(音声)を
1つのffmpegプロセスで同時に取り込むと、単一ffmpeg内部のA/V同期がth08の描画
タイミングを律速し、AWS環境で重複フレーム率が85%超まで悪化するというもの。
th07はこの問題の影響を受けない(4.7%で正常)ことも確認済みだが、これも
「安全側に倒すなら両タイトルとも音声分離が望ましい」(reports/26)との
記載に従い、本モジュールでは両タイトルとも既定で映像・音声を別プロセスで
録画し、停止後に `-c copy -shortest` で結合する方式のみを実装する。

映像・音声を別プロセスで録画する副作用として、両プロセスの起動から実際に
キャプチャを開始するまでの初期化レイテンシが異なり(pulseの方がx11grabより
数百ms〜1秒超遅い)、素朴に結合すると音声が映像より数百ms先行して聴こえる
音ズレが生じることが判明した(th08実機で約700ms、touhou-recorder reports/28)。
build_video_ffmpeg_cmd/build_audio_ffmpeg_cmd で両ffmpegに`-copyts`を付与して
実際の絶対キャプチャ開始時刻(wallclockベースのepoch秒)を出力ファイルの
start_timeとして保持し、mux_audio_video()がその差分を実測して遅く始まった側に
`-itsoffset`を与えることで補正する(ハードコードされた定数ではなく毎回実測)。
"""
import io
import json
import os
import re
import signal
import subprocess
import time
from dataclasses import dataclass, field

import numpy as np
from PIL import Image

XVFB_SCREEN = "800x600x24"

# 終了検知(画面静止判定)の閾値・待機。PoC(touhou-recorder reports/13・14)の
# 実測に基づく。変更する場合は当該レポートの根拠を必ず確認すること。
STILL_MAD_THRESHOLD = 2.0
STILL_CONSECUTIVE_REQUIRED = 8  # 8 * POLL_INTERVAL_SEC = 16秒
POLL_INTERVAL_SEC = 2.0
POST_START_GRACE_SEC = 15.0
TIMEOUT_SEC = 40 * 60

# 進捗スクリーンショットの書き出し間隔。POLL_INTERVAL_SEC(2秒)毎に取得している
# フレームのうち5回に1回だけ保存する(=約10秒毎)。既存のMAD差分検知用のffmpeg
# キャプチャを流用するため、追加のffmpeg呼び出しは発生しない。
PROGRESS_SNAPSHOT_EVERY_N_POLLS = 5

# 処理落ち(reports/12・13・22)の早期検知。通常ポーリング(2秒間隔)では処理落ち中
# でも2秒あれば別のフレームを捉えてしまい見逃すため、0.15秒間隔の短時間サンプリング
# で判定する。処理落ちは実測ではすべて録画開始25秒以内に発生していたため、早期
# 打ち切り判定は録画開始5分以内に限定する(それ以降の高い重複率はリプレイが正常に
# 終了して結果画面(静止画面)に達したケースと区別がつかないため、reports/22)。
STUTTER_PROBE_SAMPLES = 10
STUTTER_PROBE_INTERVAL_SEC = 0.15
STUTTER_PROBE_PERIOD_SEC = 60.0
STUTTER_DUP_FRACTION_THRESHOLD = 0.7
STUTTER_PROBE_ACTIVE_UNTIL_SEC = 300.0

# mods/common/fps_monitor.cpp が5秒ごとにログ出力する
# "FpsMonitor: N GetDeviceState calls in M ms (H.H Hz)" 行からHz値を読み取る。
# 正常時は55〜65Hz程度(垂直同期相当)で安定するが、fps暴走時は実測で479〜2700Hzに
# 達する(reports/22)。単発のノイズ(実測最大118Hz、直後に正常値へ復帰、reports/23)
# を誤検知しないよう、閾値超過が2回連続(出力間隔5秒×2=約10秒間持続)した場合のみ
# 異常とみなす。th07のMODはFpsMonitorを組み込んでいないため、このチェックは
# th07では実質的に発火しない(ログに"FpsMonitor:"行が現れないため常にNoneを返す)。
FPS_MONITOR_HZ_RE = re.compile(r"FpsMonitor:.*\(([\d.]+) Hz\)")
FPS_RUNAWAY_HZ_THRESHOLD = 100.0
FPS_RUNAWAY_CONSECUTIVE_REQUIRED = 2

MAX_ATTEMPTS_DEFAULT = 3
MAX_DUPLICATE_RATE_DEFAULT = 30.0


@dataclass(frozen=True)
class GameConfig:
    """タイトルごとに異なる値をまとめたもの(record_th07.py / record_th08.py が組み立てる)。"""

    game_id: str  # "th07" / "th08"(ログメッセージ・自動再生ログのファイル名接頭辞に使う)
    display: str  # Xvfb のディスプレイ番号(例 ":97")。同一ホストでの多重起動を避けるため
    wineprefix: str
    instance_dir: str
    game_dir_src: str
    canonical_slot: str  # アップロードされた任意ファイル名リプレイを配置する正規スロット名
    injector_path: str
    hook_dll_path: str
    game_exe: str = field(init=False)
    hook_dll: str = field(init=False)
    log_path: str = field(init=False)
    injector: str = "injector.exe"
    pulse_source: str = "auto_null.monitor"

    def __post_init__(self):
        object.__setattr__(self, "game_exe", f"{self.game_id}.exe")
        object.__setattr__(self, "hook_dll", f"{self.game_id}_hook.dll")
        object.__setattr__(self, "log_path", f"{self.instance_dir}/{self.game_id}_autoplay.log")

    def build_env(self):
        env = os.environ.copy()
        env["WINEPREFIX"] = self.wineprefix
        env["DISPLAY"] = self.display
        # 日本語ロケールを明示しないと動的描画の日本語が文字化けする(reports/13)。
        env["LANG"] = "ja_JP.UTF-8"
        env["LC_ALL"] = "ja_JP.UTF-8"
        return env


def log_with_prefix(prefix, msg):
    print(f"[{prefix} {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def ensure_xvfb(config, env, log=print):
    check = subprocess.run(["xdotool", "search", "--name", "."], env=env, capture_output=True)
    if check.returncode == 0:
        log(f"Xvfb {config.display} は起動済みとみなして再利用します")
        return
    log(f"Xvfb {config.display} を起動します")
    subprocess.Popen(
        ["Xvfb", config.display, "-screen", "0", XVFB_SCREEN],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(1.5)
    subprocess.Popen(
        ["openbox", "--sm-disable"], env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(1.0)


def prepare_instance(config, replay_path, log=print):
    """ゲーム一式を instance ディレクトリへ複製し、録画対象リプレイだけを
    正規スロット名で replay/ 配下に配置する。"""
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
    if os.path.exists(config.log_path):
        os.remove(config.log_path)
    log(f"instance 準備完了 (対象リプレイを {config.canonical_slot} として配置)")


def find_window(config, env, pid):
    out = subprocess.run(
        ["xdotool", "search", "--pid", str(pid)], env=env, capture_output=True, text=True
    ).stdout.split()
    for w in out:
        info = subprocess.run(["xwininfo", "-id", w], env=env, capture_output=True, text=True).stdout
        if "IsViewable" not in info:
            continue
        x = y = wd = ht = None
        for line in info.splitlines():
            line = line.strip()
            # クロップ座標は xwininfo の Absolute upper-left を使う
            # (xdotool getwindowgeometry だとタイトルバー分ズレる, AGENTS.md)。
            if line.startswith("Absolute upper-left X:"):
                x = int(line.split(":")[1])
            elif line.startswith("Absolute upper-left Y:"):
                y = int(line.split(":")[1])
            elif line.startswith("Width:"):
                wd = int(line.split(":")[1])
            elif line.startswith("Height:"):
                ht = int(line.split(":")[1])
        if wd and wd > 100 and ht and ht > 100:
            return x, y, wd, ht, w
    return None


def find_live_game_pid(game_exe):
    """game_exeのPIDのうち、zombie(状態Z)ではないものを1つ返す(なければNone)。
    コンテナ内ではPID 1(entrypoint.py)がinitのように孤児プロセスをreapする仕組みを
    持たないため、前の試行でSIGKILLしたプロセスがzombieのまま残り続けることがある。
    `pgrep -x`はzombieもマッチしてしまうため、2回目以降の試行で新しいプロセスでは
    なく前回のzombieのPIDを掴んでしまい、ウィンドウが永遠に見つからない原因になって
    いた(reports/24)。"""
    out = subprocess.run(["pgrep", "-x", game_exe], capture_output=True, text=True).stdout.split()
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


def kill_wine_and_wait(config, env, game_exe):
    """ゲーム本体とwineserverを終了させ、実際にwineserverが終了するまで待つ。
    固定sleepで待っていたところ、AWSのようにCPUが逼迫した環境ではwineserverの
    終了処理自体に2秒以上かかることがあり、終了前に次の試行のinjectorを起動して
    ウィンドウ検出に失敗する事象が確認された(reports/24)。`wineserver -w`は
    現在起動中のwineserverが実際に終了するまでブロックするため、固定時間の
    推測より確実。"""
    subprocess.run(["pkill", "-9", "-x", game_exe])
    subprocess.run(["wineserver", "-k"], env=env)
    subprocess.run(["wineserver", "-w"], env=env, timeout=60)


def wait_for_log_marker(log_path, marker, timeout, poll_interval=0.1, log_all=False, seen_lines=None, log=print):
    if seen_lines is None:
        seen_lines = set()
    t0 = time.time()
    while time.time() - t0 < timeout:
        if os.path.exists(log_path):
            with open(log_path) as f:
                lines = f.readlines()
            for line in lines:
                if line in seen_lines:
                    continue
                seen_lines.add(line)
                if log_all:
                    log(f"MODログ: {line.strip()}")
                if marker in line:
                    return time.time()
        time.sleep(poll_interval)
    return None


def grab_frame(config, env, x, y, w, h):
    """終了検知用のグレースケール縮小画像と、進捗スクリーンショット用のカラー画像を
    同じffmpegキャプチャから作る(1回のキャプチャで両方をまかない、追加コストを出さない)。"""
    cmd = [
        "ffmpeg", "-y", "-f", "x11grab", "-draw_mouse", "0", "-video_size", f"{w}x{h}",
        "-i", f"{config.display}+{x},{y}", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-",
    ]
    result = subprocess.run(cmd, env=env, capture_output=True)
    color = Image.open(io.BytesIO(result.stdout)).convert("RGB")
    gray = np.asarray(color.convert("L").resize((160, 120)), dtype=np.float32)
    return gray, color


def grab_frame_gray(config, env, x, y, w, h):
    """stutter probe専用の軽量版(カラー画像のデコードを省く)。"""
    cmd = [
        "ffmpeg", "-y", "-f", "x11grab", "-draw_mouse", "0", "-video_size", f"{w}x{h}",
        "-i", f"{config.display}+{x},{y}", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-",
    ]
    result = subprocess.run(cmd, env=env, capture_output=True)
    img = Image.open(io.BytesIO(result.stdout)).convert("L").resize((160, 120))
    return np.asarray(img, dtype=np.float32)


def mad(a, b):
    return float(np.mean(np.abs(a - b)))


def probe_stutter(config, env, x, y, w, h):
    """短時間(約1.5秒)に複数フレームを0.15秒間隔で連続キャプチャし、隣接フレーム間が
    ほぼ同一(MAD<STILL_MAD_THRESHOLD)である割合を返す。60fpsで本来動いているはずの
    短い間隔でこの割合が高ければ、処理落ち(重複フレーム多発、reports/12・13・22)の
    疑いが強い。"""
    frames = [grab_frame_gray(config, env, x, y, w, h)]
    for _ in range(STUTTER_PROBE_SAMPLES - 1):
        time.sleep(STUTTER_PROBE_INTERVAL_SEC)
        frames.append(grab_frame_gray(config, env, x, y, w, h))
    dup_count = sum(
        1 for i in range(1, len(frames)) if mad(frames[i - 1], frames[i]) < STILL_MAD_THRESHOLD
    )
    return dup_count / (len(frames) - 1)


def scan_fps_runaway(log_path):
    """log_path全体からFpsMonitorのHz値を読み取り、閾値超過が
    FPS_RUNAWAY_CONSECUTIVE_REQUIRED回連続していればその最大値を返す(なければNone)。
    ファイル全体を毎回読み直す(ログは小さいため負荷は無視できる)。"""
    if not os.path.exists(log_path):
        return None
    with open(log_path) as f:
        text = f.read()
    hz_values = [float(v) for v in FPS_MONITOR_HZ_RE.findall(text)]
    for i in range(len(hz_values) - FPS_RUNAWAY_CONSECUTIVE_REQUIRED + 1):
        window = hz_values[i:i + FPS_RUNAWAY_CONSECUTIVE_REQUIRED]
        if all(v > FPS_RUNAWAY_HZ_THRESHOLD for v in window):
            return max(window)
    return None


def save_progress_snapshot(progress_dir, color_frame, elapsed_seconds, expected_duration_seconds):
    """録画中の画面プレビュー(frame.jpg)と進捗算出用の状態(state.json)を書き出す。
    entrypoint.py側のバックグラウンドスレッドがこれをポーリングしてS3へアップロードする。
    一時ファイル→os.replaceでアトミックに上書きし、読み手が書きかけファイルを掴まないようにする。
    """
    thumb = color_frame.copy()
    thumb.thumbnail((480, 480))
    tmp_frame_path = f"{progress_dir}/frame.jpg.tmp"
    thumb.save(tmp_frame_path, "JPEG", quality=80)
    os.replace(tmp_frame_path, f"{progress_dir}/frame.jpg")

    state = {"elapsedSeconds": elapsed_seconds, "expectedDurationSeconds": expected_duration_seconds}
    tmp_state_path = f"{progress_dir}/state.json.tmp"
    with open(tmp_state_path, "w") as f:
        json.dump(state, f)
    os.replace(tmp_state_path, f"{progress_dir}/state.json")


def build_video_ffmpeg_cmd(config, x, y, w, h, video_output, watermark_path, watermark_width):
    """映像のみを録画するffmpegコマンド(音声は別プロセス、reports/26参照)。
    `-copyts`で実際の絶対キャプチャ開始時刻(wallclockベースのepoch秒)を出力ファイルの
    start_timeとして保持する。mux時にこれを使ってA/V同期を補正する(reports/28参照)。
    """
    cmd = [
        "ffmpeg", "-y", "-copyts",
        "-f", "x11grab", "-draw_mouse", "0", "-video_size", f"{w}x{h}", "-framerate", "60",
        "-i", f"{config.display}+{x},{y}",
    ]
    if watermark_path:
        # ウォーターマーク webm の VP9 アルファは libvpx 経由デコーダでないと
        # 不透明扱いになる(reports/18)。-c:v libvpx-vp9 を明示する。
        wm_w = min(watermark_width, w // 2)
        cmd += ["-c:v", "libvpx-vp9", "-i", watermark_path]
        cmd += [
            "-filter_complex",
            f"[1:v]scale={wm_w}:-1[wm];[0:v][wm]overlay=x=W-w-8:y=H-h-8:eof_action=pass[v]",
            "-map", "[v]",
        ]
    cmd += [
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        video_output,
    ]
    return cmd


def build_audio_ffmpeg_cmd(config, audio_output):
    """音声のみを録画するffmpegコマンド(別プロセス、reports/26参照)。
    `-copyts`はbuild_video_ffmpeg_cmd()と同じ理由(reports/28参照)。"""
    return [
        "ffmpeg", "-y", "-copyts", "-f", "pulse", "-i", config.pulse_source,
        "-c:a", "aac", "-b:a", "192k", audio_output,
    ]


def ffprobe_start_time(path, env):
    """-copytsで保持した絶対wallclock秒(epoch秒)のstart_timeを取得する。取得失敗時はNoneを返す。"""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=start_time",
             "-of", "default=nw=1:nk=1", path],
            env=env, capture_output=True, text=True, timeout=10,
        )
        return float(out.stdout.strip())
    except (subprocess.SubprocessError, ValueError, OSError):
        return None


def mux_audio_video(video_path, audio_path, output_path, env, log=print):
    """映像・音声を結合する(再エンコードなし)。

    x11grab(映像)とpulse(音声)は起動から実際にキャプチャを開始するまでの初期化
    レイテンシが異なり(音声側が数百ms〜1秒超遅い、touhou-recorder reports/28)、
    素朴に結合すると音声が映像より数百ms先行して聴こえる音ズレが生じる。
    build_video_ffmpeg_cmd/build_audio_ffmpeg_cmd が付与する`-copyts`で保持した
    絶対start_time(wallclockベース、epoch秒)の差分を実測し、遅く始まった側に
    `-itsoffset`を与えることでハードコードされた定数を使わずに毎回自動補正する。
    """
    video_offset = 0.0
    audio_offset = 0.0
    v_start = ffprobe_start_time(video_path, env)
    a_start = ffprobe_start_time(audio_path, env)
    if v_start is not None and a_start is not None:
        delta = a_start - v_start
        if delta > 0:
            audio_offset = delta
        elif delta < 0:
            video_offset = -delta
        log(
            f"A/V同期補正: video_start={v_start:.3f} audio_start={a_start:.3f} "
            f"delta={delta:+.3f}s (video_offset={video_offset:.3f}s audio_offset={audio_offset:.3f}s)"
        )
    else:
        log("WARNING: -copytsのstart_time取得に失敗したため、A/V同期補正をスキップします")

    cmd = ["ffmpeg", "-y"]
    if video_offset:
        cmd += ["-itsoffset", f"{video_offset:.6f}"]
    cmd += ["-i", video_path]
    if audio_offset:
        cmd += ["-itsoffset", f"{audio_offset:.6f}"]
    cmd += ["-i", audio_path, "-c", "copy", "-shortest", output_path]
    log(f"mux実行: {' '.join(cmd)}")
    result = subprocess.run(cmd, env=env, capture_output=True)
    if result.returncode != 0:
        log(f"WARNING: mux失敗 (returncode={result.returncode}): {result.stderr[-2000:].decode(errors='replace')}")
    return result.returncode == 0


def measure_duplicate_rate(video_path, start_sec, duration_sec):
    """録画動画の指定区間について、mpdecimateフィルタで重複フレーム率(%)を計測する。
    ウィンドウ再作成等による処理落ち(reports/12・13・22)の事後検知に使う。
    計測に失敗した場合はNoneを返す。"""
    try:
        probe_out = subprocess.run(
            [
                "ffprobe", "-v", "error", "-select_streams", "v:0",
                "-read_intervals", f"{start_sec}%+{duration_sec}",
                # ffmpeg 6.x(Ubuntu 24.04 のワーカーイメージが導入するバージョン)では
                # 旧称の `pkt_pts_time` は出力されなくなっている(空文字列を返し続け、
                # 常にNoneになる不具合を実機テストで確認した)。現行の `pts_time` を使う。
                "-show_entries", "frame=pts_time", "-of", "csv=p=0", video_path,
            ],
            capture_output=True, text=True, check=True,
        ).stdout
        total_frames = len([line for line in probe_out.splitlines() if line.strip()])
        if total_frames == 0:
            return None

        decimate_result = subprocess.run(
            [
                "ffmpeg", "-i", video_path, "-ss", str(start_sec), "-t", str(duration_sec),
                "-vf", "mpdecimate", "-vsync", "0", "-an", "-f", "null", "-",
            ],
            capture_output=True, text=True,
        )
        matches = re.findall(r"frame=\s*(\d+)", decimate_result.stderr)
        if not matches:
            return None
        unique_frames = int(matches[-1])

        return round(max(0.0, (1 - unique_frames / total_frames) * 100), 1)
    except (subprocess.CalledProcessError, ValueError, ZeroDivisionError, OSError):
        return None


def _failure_result(config, env, log):
    """game_pid/ウィンドウ検出/安定確認のいずれかが失敗した場合の戻り値。
    output_exists=Falseにしておけばrecord_with_retry()の失敗判定がそのまま効く
    (reports/24で、以前はsys.exit(1)によりリトライループごとプロセスが終了して
    しまう不具合があった教訓を踏まえた設計)。"""
    kill_wine_and_wait(config, env, config.game_exe)
    return {
        "output_exists": False,
        "classification": "setup_error",
        "fps_runaway_hz": None,
        "total_record_sec": 0.0,
    }


def attempt_recording(config, replay_path, output_path, watermark_path, watermark_width,
                       progress_dir, expected_duration_seconds, log=print):
    """録画を1回試行する。戻り値: dict(output_exists, classification, fps_runaway_hz, total_record_sec)。
    classification は "good" / "fps_runaway" / "stutter" / "timeout" / "setup_error" のいずれか。
    """
    env = config.build_env()
    ensure_xvfb(config, env, log=log)
    prepare_instance(config, replay_path, log=log)

    log("injector を起動します")
    subprocess.Popen(
        ["wine", config.injector, config.game_exe, config.hook_dll],
        cwd=config.instance_dir, env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    game_pid = None
    t0 = time.time()
    while time.time() - t0 < 20:
        game_pid = find_live_game_pid(config.game_exe)
        if game_pid:
            break
        time.sleep(0.1)
    if not game_pid:
        log(f"ERROR: {config.game_exe} プロセスが検出できませんでした")
        return _failure_result(config, env, log)
    log(f"game_pid={game_pid} ({time.time()-t0:.1f}s)")

    geom = None
    t0 = time.time()
    while time.time() - t0 < 20:
        geom = find_window(config, env, game_pid)
        if geom:
            break
        time.sleep(0.1)
    if not geom:
        log("ERROR: ゲームウィンドウが検出できませんでした")
        return _failure_result(config, env, log)
    x, y, w, h, winid = geom
    log(f"ウィンドウ検出: x={x} y={y} w={w} h={h} (winid={winid})")

    seen_lines = set()
    stable_time = wait_for_log_marker(
        config.log_path, "WaitForStableWindow: stable", timeout=20, poll_interval=0.1,
        log_all=True, seen_lines=seen_lines, log=log,
    )
    if stable_time is None:
        log("ERROR: ウィンドウの安定を確認できませんでした")
        return _failure_result(config, env, log)
    log("ウィンドウの安定を確認しました。録画を開始します")

    base, _ext = os.path.splitext(output_path)
    video_target = f"{base}.video.mp4"
    audio_target = f"{base}.audio.m4a"

    video_cmd = build_video_ffmpeg_cmd(config, x, y, w, h, video_target, watermark_path, watermark_width)
    log(f"録画開始(映像): {' '.join(video_cmd)}")
    video_log_path = f"{os.path.dirname(output_path)}/ffmpeg_video.log"
    video_log_file = open(video_log_path, "wb")
    video_proc = subprocess.Popen(
        video_cmd, env=env, stdin=subprocess.PIPE, stdout=video_log_file, stderr=subprocess.STDOUT,
    )

    audio_cmd = build_audio_ffmpeg_cmd(config, audio_target)
    log(f"録画開始(音声・別プロセス): {' '.join(audio_cmd)}")
    audio_log_path = f"{os.path.dirname(output_path)}/ffmpeg_audio.log"
    audio_log_file = open(audio_log_path, "wb")
    audio_proc = subprocess.Popen(
        audio_cmd, env=env, stdin=subprocess.PIPE, stdout=audio_log_file, stderr=subprocess.STDOUT,
    )
    record_start = time.time()

    sequence_complete_time = wait_for_log_marker(
        config.log_path, "sequence complete", timeout=20, poll_interval=0.1,
        log_all=True, seen_lines=seen_lines, log=log,
    )
    if sequence_complete_time is None:
        log("WARNING: MOD のキーシーケンス完了ログが検出できませんでした")
        sequence_complete_time = time.time()

    gameplay_start = sequence_complete_time
    log(f"リプレイ再生開始とみなす時刻から監視開始(猶予{POST_START_GRACE_SEC}秒)")

    prev_frame = None
    consecutive_still = 0
    detected = False
    stutter_detected = False
    fps_runaway_hz = None
    poll_count = 0
    next_stutter_probe = POST_START_GRACE_SEC
    while True:
        elapsed = time.time() - gameplay_start
        if elapsed > TIMEOUT_SEC:
            log(f"TIMEOUT: {TIMEOUT_SEC}秒経過したため強制停止します")
            break

        runaway_hz = scan_fps_runaway(config.log_path)
        if runaway_hz is not None:
            log(f"WARNING: FpsMonitorログで異常な高fps({runaway_hz:.1f}Hz)を検知しました。早期終了します")
            fps_runaway_hz = runaway_hz
            break

        if elapsed < POST_START_GRACE_SEC:
            time.sleep(POLL_INTERVAL_SEC)
            continue

        if elapsed >= next_stutter_probe and elapsed < STUTTER_PROBE_ACTIVE_UNTIL_SEC:
            dup_fraction = probe_stutter(config, env, x, y, w, h)
            elapsed_after_probe = time.time() - gameplay_start
            next_stutter_probe = elapsed_after_probe + STUTTER_PROBE_PERIOD_SEC
            log(f"stutter probe: elapsed={elapsed_after_probe:.1f}s dup_fraction={dup_fraction:.2f}")
            if dup_fraction >= STUTTER_DUP_FRACTION_THRESHOLD:
                log(f"WARNING: 短間隔サンプリングでの重複フレーム率({dup_fraction:.2f})が閾値を超えました。早期終了します")
                stutter_detected = True
                break
            prev_frame = None  # プローブでffmpeg呼び出しの時間が経っているため、次回はここから再計測する

        frame, color_frame = grab_frame(config, env, x, y, w, h)
        poll_count += 1
        if progress_dir and poll_count % PROGRESS_SNAPSHOT_EVERY_N_POLLS == 0:
            save_progress_snapshot(progress_dir, color_frame, elapsed, expected_duration_seconds)
        if prev_frame is not None:
            d = mad(prev_frame, frame)
            if d < STILL_MAD_THRESHOLD:
                consecutive_still += 1
            else:
                consecutive_still = 0
            log(f"poll: elapsed={elapsed:.1f}s MAD={d:.2f} still={consecutive_still}")
            if consecutive_still >= STILL_CONSECUTIVE_REQUIRED:
                log("画面が一定時間変化しなくなったためリプレイ終了と判定しました")
                detected = True
                break
        prev_frame = frame
        time.sleep(POLL_INTERVAL_SEC)

    log("録画を停止します (SIGINT)")
    video_proc.send_signal(signal.SIGINT)
    audio_proc.send_signal(signal.SIGINT)
    try:
        video_proc.wait(timeout=20)
    except subprocess.TimeoutExpired:
        log("WARNING: ffmpeg(映像) が時間内に終了しなかったため terminate します")
        video_proc.terminate()
        video_proc.wait(timeout=10)
    video_log_file.close()
    log(f"ffmpeg(映像) exit_code={video_proc.returncode}")
    try:
        audio_proc.wait(timeout=20)
    except subprocess.TimeoutExpired:
        log("WARNING: ffmpeg(音声) が時間内に終了しなかったため terminate します")
        audio_proc.terminate()
        audio_proc.wait(timeout=10)
    audio_log_file.close()
    log(f"ffmpeg(音声) exit_code={audio_proc.returncode}")

    output_exists = False
    if os.path.exists(video_target) and os.path.exists(audio_target):
        output_exists = mux_audio_video(video_target, audio_target, output_path, env, log=log)
    else:
        log(f"WARNING: 映像/音声の中間ファイルが見つかりません: video={video_target} audio={audio_target}")

    if output_exists:
        log(f"出力ファイル: {output_path} ({os.path.getsize(output_path)} bytes)")
    else:
        # 失敗時の診断のため、ffmpegログの末尾をCloudWatch Logsに残す(ffmpeg.logは
        # ファイルなのでawslogsドライバに拾われず、コンテナ破棄で消えてしまうため)。
        for label, path in (("映像", video_log_path), ("音声", audio_log_path)):
            try:
                with open(path, "rb") as f:
                    tail = f.read()[-2000:]
                log(f"ffmpeg({label})ログ末尾: {tail.decode(errors='replace')}")
            except OSError:
                pass

    total_record_sec = time.time() - record_start
    if fps_runaway_hz is not None:
        classification = "fps_runaway"
        stop_reason = "fps暴走早期検知"
    elif stutter_detected:
        classification = "stutter"
        stop_reason = "処理落ち早期検知"
    elif detected:
        classification = "good"
        stop_reason = "画面静止検知"
    else:
        classification = "timeout"
        stop_reason = "タイムアウト"
    log(f"録画終了。総録画時間 {total_record_sec:.1f}秒 検知方式: {stop_reason}")

    kill_wine_and_wait(config, env, config.game_exe)

    return {
        "output_exists": output_exists,
        "classification": classification,
        "fps_runaway_hz": fps_runaway_hz,
        "total_record_sec": total_record_sec,
    }


def record_with_retry(config, replay_path, output_path, *, watermark_path=None, watermark_width=285,
                       progress_dir=None, expected_duration_seconds=None,
                       max_attempts=MAX_ATTEMPTS_DEFAULT, max_duplicate_rate=MAX_DUPLICATE_RATE_DEFAULT,
                       log=print):
    """attempt_recording()を最大max_attempts回試行し、fps暴走・処理落ちの早期検知や
    事後の重複フレーム率チェックに引っかかった場合は出力を破棄してリトライする。
    正常な録画が得られればTrueを、max_attempts回失敗すればFalseを返す。"""
    for attempt in range(1, max_attempts + 1):
        log(f"=== 試行 {attempt}/{max_attempts} ===")
        result = attempt_recording(
            config, replay_path, output_path, watermark_path, watermark_width,
            progress_dir, expected_duration_seconds, log=log,
        )
        if not result["output_exists"]:
            log("WARNING: 出力ファイルが生成されなかったため、この試行は失敗として扱います")
            continue
        if result["classification"] == "fps_runaway":
            log(f"WARNING: fps暴走({result['fps_runaway_hz']:.1f}Hz)を検知したため破棄してリトライします")
            continue
        if result["classification"] == "stutter":
            log("WARNING: 処理落ちの早期検知によりこの試行を破棄してリトライします")
            continue

        dup_rate = measure_duplicate_rate(output_path, 15, min(30, max(5, result["total_record_sec"] - 15)))
        log(f"録画開始15秒以降の重複フレーム率: {dup_rate}%")
        if dup_rate is not None and dup_rate > max_duplicate_rate:
            log(f"WARNING: 重複フレーム率({dup_rate}%)が閾値({max_duplicate_rate}%)を超えました。破棄してリトライします")
            continue

        log(f"試行{attempt}で正常な録画を確認しました")
        return True

    log(f"ERROR: {max_attempts}回試行しても正常な録画が得られませんでした")
    return False
