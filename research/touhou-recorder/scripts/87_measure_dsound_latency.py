#!/usr/bin/env python3
"""Wine DirectSound の出力遅延を、倍速録画の各倍率の構成で測る(フェーズ87)。

`scripts/87_dsound_latency_probe/dslatency.exe` を、recorder/ の倍速録画と同じ構成
(倍率×44100Hz の専用null-sinkを `PULSE_SINK` で指定し、SetFrequencyで再生周波数も倍率分
上げる)で実行し、そのシンクのmonitorを recorder/ と同じ `ffmpeg -copyts -f pulse` で録音する。
録音上のクリックの絶対時刻(start_time + 位置)と、プローブが出力した Play 直前の壁時計時刻
から期待されるクリック時刻との差を「出力遅延」として出す。

`ffmpeg -f pulse` のタイムスタンプ自体の偏り等も含むので絶対値には意味が薄いが、
**等倍(44100Hz)との差**が倍速録画で映像に対して余分に生じる音声遅延(実時間)になる。

Usage:
  Xvfb :91 -screen 0 640x480x24 &
  DISPLAY=:91 WINEPREFIX=$PWD/prefixes/th15-wined3d-gl \\
    python3 scripts/87_measure_dsound_latency.py --mults 1,1.5,2,3,4 --repeat 3
"""
import argparse
import os
import re
import signal
import subprocess
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
PROBE = os.path.join(HERE, "87_dsound_latency_probe", "dslatency.exe")


def pactl(*args):
    env = dict(os.environ, LC_ALL="C")
    return subprocess.run(["pactl", *args], capture_output=True, text=True, env=env).stdout.strip()


def measure(rate, out_path, default_sink=None):
    """default_sink を指定すると recorder/ の等倍録画と同じ構成(PULSE_SINK無しで既定シンクへ
    出力し、そのmonitorをAAC/m4aで録音)で測る。"""
    if default_sink:
        sink, mod = default_sink, None
        out_path = out_path.rsplit(".", 1)[0] + ".m4a"
        rec_args = ["-i", f"{sink}.monitor", "-c:a", "aac", "-b:a", "192k", out_path]
    else:
        sink = f"p87lat{rate}"
        mod = pactl("load-module", "module-null-sink", f"sink_name={sink}", f"rate={rate}", "channels=2")
        rec_args = ["-sample_rate", str(rate), "-i", f"{sink}.monitor", "-c:a", "pcm_s16le", out_path]
    try:
        rec = subprocess.Popen(
            ["ffmpeg", "-y", "-copyts", "-f", "pulse"] + rec_args,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1.0)
        env = dict(os.environ, WINEDEBUG="-all")
        if not default_sink:
            env["PULSE_SINK"] = sink
        out = subprocess.run(["wine", PROBE, "--freq", str(rate)], capture_output=True, text=True,
                             env=env).stdout
        time.sleep(0.5)
        rec.send_signal(signal.SIGINT)
        rec.wait()
    finally:
        if mod:
            pactl("unload-module", mod)
    m = re.search(r"PLAY_EPOCH ([0-9.]+) FREQ \d+ CLICK_INTERVAL ([0-9.]+)", out)
    t0, interval = float(m.group(1)), float(m.group(2))
    start = float(subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=start_time", "-of", "csv=p=0", out_path],
        capture_output=True, text=True).stdout.strip())
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", out_path, "-ac", "1", "-f", "s16le", "-"],
                         capture_output=True).stdout
    a = np.abs(np.frombuffer(raw, np.int16).astype(np.int32))
    hits = np.where(a > 8000)[0]
    onsets = [hits[0]] + [h for prev, h in zip(hits, hits[1:]) if h - prev > rate * interval / 2]
    abs_times = [start + h / rate for h in onsets]
    lat = [t - (t0 + (k + 1) * interval) for k, t in enumerate(abs_times)]
    return lat


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mults", default="1,1.5,2,3,4")
    ap.add_argument("--repeat", type=int, default=3)
    ap.add_argument("--workdir", default="/tmp/p87_dslatency")
    ap.add_argument("--default-sink", default=None,
                    help="等倍録画と同じ既定シンク経路(例: auto_null)も比較対象に加える")
    args = ap.parse_args()
    os.makedirs(args.workdir, exist_ok=True)
    configs = [(float(m), None) for m in args.mults.split(",")]
    if args.default_sink:
        configs.insert(0, (1.0, args.default_sink))
    for mult, dsink in configs:
        rate = round(44100 * mult)
        label = f"default:{dsink}" if dsink else f"sink{rate}"
        means = []
        for r in range(args.repeat):
            lat = measure(rate, f"{args.workdir}/lat_{label.replace(':', '_')}_{r}.mov", dsink)
            means.append(float(np.mean(lat)))
            print(f"{label:<18} freq={rate:<6} run{r}: clicks={len(lat)} "
                  f"latency(ms)={' '.join(f'{x * 1000:.1f}' for x in lat)}", flush=True)
        print(f"== {label} mean latency {np.mean(means) * 1000:.1f}ms (runs: "
              f"{', '.join(f'{x * 1000:.1f}' for x in means)})", flush=True)


if __name__ == "__main__":
    main()
