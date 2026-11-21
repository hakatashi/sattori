#!/usr/bin/env python3
"""A/V同期の「正解」を合成プローブで作り、recorder/ のmux結果の誤差を直接測る(フェーズ88)。

scripts/88_av_flash_probe/avflash.exe(Wine上で、DirectSoundのクリックをPlayした直後に
ウィンドウを白く光らせる)を、recorder/ffmpeg.py の build_video_ffmpeg_cmd() /
build_audio_ffmpeg_cmd() が組み立てるのと同じコマンドで録画し、同じ mux_audio_video() で
結合する。出力動画上の「光った時刻」と「クリックの時刻」の差がA/V同期の誤差
(正: 音が遅れている)。同期マーカー方式(reports/88)と従来のstart_time方式の両方で結合して比べる。

倍速録画の経路は FPS_LIMIT_TARGET_HZ を指定して起動する(recorder/ の定数はimport時に決まる)。

Usage:
  python3 scripts/88_av_truth_test.py --repeat 3                            # 等倍(auto_null・AAC)
  FPS_LIMIT_TARGET_HZ=120 python3 scripts/88_av_truth_test.py --repeat 3    # 2倍速(専用シンク・PCM)
  FPS_LIMIT_TARGET_HZ=30 python3 scripts/88_av_truth_test.py --repeat 3     # 1/2倍速(auto_null・AAC)
"""
import argparse
import os
import signal
import subprocess
import sys
import threading
import time
from types import SimpleNamespace

import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
from recorder import ffmpeg as rf  # noqa: E402
from recorder import sync_marker as sm  # noqa: E402
from recorder.config import DOUBLESPEED_SINK_NAME_PREFIX  # noqa: E402
from recorder.timing import AUDIO_CAPTURE_RATE_HZ, MENU_TIME_SCALE, NATIVE_AUDIO_RATE_HZ  # noqa: E402

PROBE = os.path.join(REPO, "scripts", "88_av_flash_probe", "avflash.exe")
DISPLAY = os.environ.get("AV_TRUTH_DISPLAY", ":95")
GAME_ID = "avtest"


def pactl(*args):
    return subprocess.run(["pactl", *args], capture_output=True, text=True,
                          env=dict(os.environ, LC_ALL="C")).stdout.strip()


def flash_times(path):
    """出力動画(ファイル先頭基準)で画面が黒→白に変わったフレームの時刻。"""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-f", "lavfi", "-i", f"movie={path},signalstats",
         "-show_entries", "frame=pts_time:frame_tags=lavfi.signalstats.YAVG", "-of", "csv=p=0"],
        capture_output=True, text=True).stdout
    fr = []
    for line in out.splitlines():
        f = [x for x in line.split(",") if x]
        if len(f) == 2:
            fr.append((float(f[0]), float(f[1])))
    fmt = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=start_time",
                                "-of", "csv=p=0", path], capture_output=True, text=True).stdout)
    return [t - fmt for (t, y), (_, y0) in zip(fr[1:], fr) if y > 128 and y0 <= 128]


def click_times(path, rate=48000):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-map", "0:a", "-af",
                          "aresample=first_pts=0", "-ac", "1", "-ar", str(rate), "-f", "f32le", "-"],
                         capture_output=True).stdout
    a = np.abs(np.frombuffer(raw, np.float32))
    hits = np.where(a > 0.3)[0]
    if len(hits) == 0:
        return []
    ons = [hits[0]] + [h for p, h in zip(hits, hits[1:]) if h - p > rate * 0.5]
    return [h / rate for h in ons]


def trial(workdir, idx, count):
    speed = AUDIO_CAPTURE_RATE_HZ != NATIVE_AUDIO_RATE_HZ
    tag = f"t{idx}_{'speed' if speed else 'native'}"
    env = dict(os.environ, DISPLAY=DISPLAY, WINEDEBUG="-all")
    sink_mod = None
    if speed:
        sink = f"{DOUBLESPEED_SINK_NAME_PREFIX}_{GAME_ID}"
        sink_mod = pactl("load-module", "module-null-sink", f"sink_name={sink}",
                         f"rate={AUDIO_CAPTURE_RATE_HZ}", "channels=2")
        env["PULSE_SINK"] = sink
    trig = f"{workdir}/{tag}.trigger"
    if os.path.exists(trig):
        os.remove(trig)
    env["SYNC_MARKER_TRIGGER"] = sm.windows_path(trig)
    probe_log = f"{workdir}/{tag}.probe.log"
    config = SimpleNamespace(display=DISPLAY, game_id=GAME_ID)
    base = f"{workdir}/{tag}"
    options = SimpleNamespace(
        separate_audio=True, inline_audio=False, watermark=None, upscale_720p=False,
        gpu_encode=os.environ.get("GPU_ENCODE") == "1", video_target=f"{base}.video.mp4",
        audio_target=f"{base}.audio.mov" if speed else f"{base}.audio.m4a")
    # 低速録画は録音レートは等倍のまま、バッファの再生周波数だけ下がる(reports/91)。
    probe_freq = AUDIO_CAPTURE_RATE_HZ if speed else round(NATIVE_AUDIO_RATE_HZ / max(MENU_TIME_SCALE, 1.0))
    try:
        probe = subprocess.Popen(
            ["wine", PROBE, "--freq", str(probe_freq), "--log", sm.windows_path(probe_log),
             "--start", "8", "--count", str(count), "--interval", "1.5"],
            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1.5)
        vcmd = rf.build_video_ffmpeg_cmd(config, options, (0, 0, 320, 240))
        acmd = rf.build_audio_ffmpeg_cmd(config, options)
        vp = subprocess.Popen(vcmd, env=env, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL)
        ap = subprocess.Popen(acmd, env=env, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL)

        def touch():
            open(trig, "w").write("sync\n")
        threading.Timer(sm.TRIGGER_DELAY_SEC, touch).start()
        probe.wait()
        time.sleep(0.5)
        for p in (vp, ap):
            p.send_signal(signal.SIGINT)
        for p in (vp, ap):
            p.wait()
    finally:
        if sink_mod:
            pactl("unload-module", sink_mod)

    res = {}
    for method, log_path in (("marker", probe_log), ("start_time", None)):
        out = f"{base}.{method}.mp4"
        rf.mux_audio_video(options.video_target, options.audio_target, out, env,
                           marker_log_path=log_path)
        vt, at = flash_times(out), click_times(out)
        diffs = []
        for v in vt:
            near = [a for a in at if abs(a - v) < 0.7]
            if near:
                diffs.append(near[0] - v)
        res[method] = diffs
    return res


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repeat", type=int, default=3)
    ap.add_argument("--count", type=int, default=8)
    ap.add_argument("--workdir", default="/tmp/p88_av_truth")
    args = ap.parse_args()
    os.makedirs(args.workdir, exist_ok=True)
    # AV_TRUTH_DISPLAY で既存のX画面(AWSのGPU描画面 :94 等)を使う場合はXvfbを起動しない
    xv = None
    if "AV_TRUTH_DISPLAY" not in os.environ:
        xv = subprocess.Popen(["Xvfb", DISPLAY, "-screen", "0", "320x240x24"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1)
    try:
        for r in range(args.repeat):
            res = trial(args.workdir, r, args.count)
            for method, d in res.items():
                d = np.array(d) * 1000
                print(f"run{r} {method:10s} n={len(d)} a-v(ms) mean={d.mean():+7.1f} "
                      f"sd={d.std():5.1f} [{' '.join(f'{x:+.0f}' for x in d)}]", flush=True)
    finally:
        if xv:
            xv.terminate()


if __name__ == "__main__":
    main()
