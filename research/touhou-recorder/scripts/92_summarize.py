#!/usr/bin/env python3
"""th06ncのg6.2xlarge録画の結果をMarkdownの表にする(フェーズ92)。

scripts/92_run_worker_batch.sh・92_run_reconvert_batch.sh の出力(<logs>/<label>/ 配下)を読む。

Usage:
  python3 scripts/92_summarize.py <logsディレクトリ> <label>:<リプレイの尺(秒)>:<倍率> [...]
"""
import json
import os
import re
import statistics
import sys


def read(path):
    if not os.path.exists(path):
        return ""
    with open(path, errors="replace") as f:
        return f.read()


def one(pattern, text, last=True):
    found = re.findall(pattern, text)
    return (found[-1] if last else found[0]) if found else None


def stutter(path):
    text = read(path)
    drop = re.search(r"落ちたフレーム: (\d+) \(([\d.]+)%\)", text)
    fps = re.search(r"実効fps\s*: ([\d.]+)", text)
    return f"{fps.group(1)} ({drop.group(2)}%)" if drop and fps else "-"


def fps_monitor(text):
    vals = [float(v) for v in re.findall(r"FpsMonitor: .*\(([\d.]+) Hz\)", text)]
    vals = sorted(vals[4:-3]) if len(vals) > 12 else sorted(vals)
    if not vals:
        return "-"
    return f"{statistics.median(vals):.1f}/{vals[int(len(vals) * 0.05)]:.1f}/{vals[0]:.1f}"


def cpu_avg(text):
    idle = [float(m) for m in re.findall(r"\s+all\s+.*\s([\d.]+)\s*$", text, re.M)]
    idle = idle[30:-20] if len(idle) > 60 else idle
    return f"{100 - statistics.mean(idle):.0f}" if idle else "-"


def gpu_avg(text):
    rows = []
    for line in text.splitlines():
        cols = line.split()
        if len(cols) >= 7 and cols[0] == "0" and cols[4].isdigit() and cols[6].isdigit():
            rows.append((int(cols[4]), int(cols[6])))
    busy = [r for r in rows if r[0] > 0]
    if not busy:
        return "-"
    return f"{statistics.mean(r[0] for r in busy):.0f}/{statistics.mean(r[1] for r in busy):.0f}"


def main():
    logs = sys.argv[1]
    print("| 条件 | 試行 | スコア | 重複率 | 同期残差 | FpsMonitor 中央/下位5%/最低(Hz) | CPU% | GPU sm/enc% "
          "| 配信版の実効fps(落ち) 現行 | 同 `-r 60` | 配信版の尺-リプレイ尺 | 録画(倍率) | 変換 | 計(倍率) |")
    print("|" + "---|" * 14)
    for spec in sys.argv[2:]:
        label, dur, mult = spec.split(":")
        dur, mult = float(dur), float(mult)
        d = f"{logs}/{label}"
        run = read(f"{d}/run.log")
        attempt = one(r"試行(\d+)で正常な録画", run)
        desync = json.loads(read(f"{d}/desync_result.json") or "{}").get("desyncDetected")
        dup = one(r"重複フレーム率: ([\d.]+)%", run)
        res = one(r"同期マーカー検証\(.*\): 残差=([+-][\d.]+)ms", run)
        t = json.loads(read(f"{d}/timing.json") or "{}")
        rec = t.get("record_done", 0) - t.get("assets_done", 0)
        conv = t.get("convert_done", 0) - t.get("record_done", 0)
        delivery = one(r"duration=([\d.]+)", read(f"{d}/probe_delivery.txt"))
        delta = f"{float(delivery) - dur:+.1f}s" if delivery else "-"
        print(f"| {label} | {attempt or '失敗'} | {'一致' if desync is False else desync} | {dup}% | {res}ms "
              f"| {fps_monitor(read(f'{d}/th06nc_autoplay.log'))} | {cpu_avg(read(f'{d}/cpu.txt'))} "
              f"| {gpu_avg(read(f'{d}/gpu.txt'))} | {stutter(f'{d}/stutter.txt')} "
              f"| {stutter(f'{d}/stutter_r60.txt') if mult != 1 else '(同左)'} | {delta} "
              f"| {rec:.0f}s (×{rec / dur:.2f}) | {conv:.0f}s | {rec + conv:.0f}s (×{(rec + conv) / dur:.2f}) |")


if __name__ == "__main__":
    main()
