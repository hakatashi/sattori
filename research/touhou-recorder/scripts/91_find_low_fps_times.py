#!/usr/bin/env python3
"""MODログのFpsMonitorで目標を最も下回った区間を、配信版の時刻へ換算して出す(フェーズ91)。

目視確認するクリップの位置を決めるために使う。

Usage:
  python3 scripts/91_find_low_fps_times.py <logdir> <label> <hz> [--top 6]
"""
import argparse
import datetime
import re


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("logdir")
    ap.add_argument("label")
    ap.add_argument("hz", type=float)
    ap.add_argument("--top", type=int, default=6)
    args = ap.parse_args()
    base = f"{args.logdir}/{args.label}"
    text = open(f"{base}.log", errors="replace").read().split("=== 試行")[-1]
    video_start = float(re.search(r"video_start=([\d.]+)", text)[1])
    end_epoch = float(re.search(r"content_end_epoch=([\d.]+)", text)[1])
    day = datetime.datetime.fromtimestamp(video_start, datetime.timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0).timestamp()
    samples, start = [], None
    for line in open(f"{base}.modlog.txt", errors="replace"):
        m = re.match(r"\[(\d+):(\d+):([\d.]+)\] (.*)", line)
        if not m:
            continue
        epoch = day + int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])
        if m[4].startswith("Step "):
            start = epoch
        f = re.search(r"FpsMonitor: .*\(([\d.]+) Hz\)", m[4])
        if f and start and start < epoch < end_epoch:
            samples.append((float(f[1]), epoch))
    scale = 60.0 / args.hz
    cut_start = start - scale  # REPLAY_START_LEAD_SEC(1秒)×time_scale
    print(f"{args.label}: 窓{len(samples)}個 / 目標の98.5%未満 "
          f"{sum(1 for v, _ in samples if v < args.hz * 0.985)}個")
    for hz, epoch in sorted(samples)[:args.top]:
        t = (epoch - cut_start) / scale
        print(f"  {hz:5.1f}Hz  配信版 {int(t // 60):02d}:{t % 60:04.1f}")


if __name__ == "__main__":
    main()
