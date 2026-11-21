#!/usr/bin/env python3
"""`ffmpeg -copyts -f pulse` の開始タイムスタンプのぶれを、実パイプラインと同じ順序で測る(フェーズ88)。

recorder/pipeline.py は「ゲーム起動(音声ストリーム接続済み・再生中)→ ffmpeg(音声)起動」の順で
録音する。本スクリプトは scripts/88_dsound_loop_probe/dsloop.exe(1秒ごとのクリックをループ再生し
続けるDirectSound音源)を先に起動し、--pre 秒後に recorder/ffmpeg.py と同じコマンドで録音を始め、
--dur 秒録音して止める。

録音には追加出力として `-f framecrc` を付け、パケットごとのpts(ffmpegのpulse入力が
`av_gettime() - pa_stream_get_latency()` をtimefilterに通して付けた値)も記録する。これにより

  - start:   format start_time + (クリック位置 / レート)                 … 現行muxが使う値
  - pkt:     クリックを含むパケットのpts + (パケット内オフセット / レート) … パケット単位の値
  - implied: 各パケットについて pts_k − (それまでのサンプル数 / レート) … 「開始時刻の推定値」の推移

を並べ、クリックの理論発音時刻(PLAY_EPOCH + m × CLICK_INTERVAL)との差を出す。

Usage:
  Xvfb :91 -screen 0 640x480x24 &
  DISPLAY=:91 WINEPREFIX=$PWD/prefixes/th15-wined3d-gl \\
    python3 scripts/88_measure_pulse_ts.py --mode native --repeat 5
  ... --mode speed --mult 2   (倍速録画と同じ専用シンク+PCM mov経路)
"""
import argparse
import os
import re
import signal
import subprocess
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
PROBE = os.path.join(HERE, "88_dsound_loop_probe", "dsloop.exe")


def pactl(*args):
    env = dict(os.environ, LC_ALL="C")
    return subprocess.run(["pactl", *args], capture_output=True, text=True, env=env).stdout.strip()


def ffprobe(path, entry):
    return subprocess.run(["ffprobe", "-v", "error", "-show_entries", entry, "-of", "csv=p=0", path],
                          capture_output=True, text=True).stdout.strip().splitlines()[0]


def read_framecrc(path):
    """framecrc の (pts[us], size[bytes]) の列。"""
    rows = []
    for line in open(path):
        if line.startswith("#") or not line.strip():
            continue
        f = [x.strip() for x in line.split(",")]
        rows.append((int(f[2]), int(f[4])))
    return rows


def trial(mode, mult, pre, dur, workdir, idx, extra_in=()):
    rate = round(44100 * mult)
    sink_mod = None
    env = dict(os.environ, WINEDEBUG="-all")
    if mode == "native":
        # recorder/ffmpeg.py のネイティブ経路と同一(-sample_rate無し=ffmpeg既定48000Hz、AAC m4a)
        out = f"{workdir}/t{idx}_native.m4a"
        rec_args = ["-f", "pulse", *extra_in, "-i", "auto_null.monitor", "-c:a", "aac", "-b:a", "192k", out]
        in_rate = 48000
    else:
        sink = "p88speed"
        sink_mod = pactl("load-module", "module-null-sink", f"sink_name={sink}", f"rate={rate}", "channels=2")
        env["PULSE_SINK"] = sink
        out = f"{workdir}/t{idx}_speed{mult:g}.mov"
        rec_args = ["-f", "pulse", *extra_in, "-sample_rate", str(rate), "-i", f"{sink}.monitor",
                    "-c:a", "pcm_s16le", out]
        in_rate = rate
    crc = out + ".crc"
    try:
        game = subprocess.Popen(["wine", PROBE, "--freq", str(rate), "--secs", str(int(pre + dur + 4))],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env)
        line = game.stdout.readline()
        m = re.search(r"PLAY_EPOCH ([0-9.]+) FREQ \d+ CLICK_INTERVAL ([0-9.]+)", line)
        t0, interval = float(m.group(1)), float(m.group(2))
        time.sleep(pre)
        rec = subprocess.Popen(
            ["ffmpeg", "-y", "-copyts", *rec_args, "-map", "0:a", "-c:a", "copy", "-f", "framecrc", crc],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
        time.sleep(dur)
        rec.send_signal(signal.SIGINT)
        rec.wait()
        game.wait()
    finally:
        if sink_mod:
            pactl("unload-module", sink_mod)

    start = float(ffprobe(out, "format=start_time"))
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", out, "-ac", "1", "-ar", str(in_rate),
                          "-f", "s16le", "-"], capture_output=True).stdout
    a = np.abs(np.frombuffer(raw, np.int16).astype(np.int32))
    hits = np.where(a > 6000)[0]
    onsets = [hits[0]] + [h for p, h in zip(hits, hits[1:]) if h - p > in_rate * interval / 2]

    pk = read_framecrc(crc)
    frame_bytes = 4  # s16le 2ch
    pts = np.array([p for p, _ in pk], dtype=np.float64) / 1e6
    cum = np.concatenate([[0], np.cumsum([s // frame_bytes for _, s in pk])[:-1]]).astype(np.float64)
    implied = pts - cum / in_rate

    lat_start, lat_pkt = [], []
    for h in onsets:
        t_start = start + h / in_rate
        # AACはエンコーダディレイ分ずれるので、パケット側はPCMのcrcのサンプル位置で対応付ける
        k = max(0, np.searchsorted(cum, h, side="right") - 1)
        t_pkt = pts[k] + (h - cum[k]) / in_rate
        # 理論発音時刻: 最も近いクリック番号
        mnum = round((t_start - t0) / interval)
        lat_start.append(t_start - (t0 + mnum * interval))
        lat_pkt.append(t_pkt - (t0 + mnum * interval))
    return dict(
        start=start, first_pts=pts[0], lat_start=np.array(lat_start), lat_pkt=np.array(lat_pkt),
        implied=implied, n_pkts=len(pk),
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mode", choices=["native", "speed"], default="native")
    ap.add_argument("--mult", type=float, default=2.0)
    ap.add_argument("--pre", type=float, default=5.0, help="音源起動から録音開始までの秒数")
    ap.add_argument("--dur", type=float, default=10.0)
    ap.add_argument("--repeat", type=int, default=3)
    ap.add_argument("--workdir", default="/tmp/p88_pulse_ts")
    ap.add_argument("--fragment-size", type=int, default=None, help="pulse入力の -fragment_size")
    args = ap.parse_args()
    os.makedirs(args.workdir, exist_ok=True)
    extra = ["-fragment_size", str(args.fragment_size)] if args.fragment_size else []
    for r in range(args.repeat):
        res = trial(args.mode, 1.0 if args.mode == "native" else args.mult,
                    args.pre, args.dur, args.workdir, r, extra)
        imp = res["implied"]
        st = res["start"]
        head = " ".join(f"{(x - st) * 1000:+.0f}" for x in imp[1:6])
        print(f"{args.mode} run{r}: lat_start={np.mean(res['lat_start'])*1000:7.1f}ms "
              f"(sd {np.std(res['lat_start'])*1000:.1f}) lat_pkt={np.mean(res['lat_pkt'])*1000:7.1f}ms "
              f"(sd {np.std(res['lat_pkt'])*1000:.1f}) "
              f"start-first_pts={(res['start']-res['first_pts'])*1000:+.1f}ms "
              f"implied[0]={(imp[0]-res['start'])*1000:+.1f} "
              f"implied[1..5]={head} "
              f"implied_med={(np.median(imp)-res['start'])*1000:+.1f} "
              f"implied_last={(imp[-1]-res['start'])*1000:+.1f}ms pkts={res['n_pkts']}", flush=True)


if __name__ == "__main__":
    main()
