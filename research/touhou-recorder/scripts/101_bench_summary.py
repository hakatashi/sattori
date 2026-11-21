#!/usr/bin/env python3
"""フェーズ101: scripts/101_bench_d3dx.sh の結果を集計する。

Usage: python3 scripts/101_bench_summary.py <bench_dir> [--timing] [--drop-start 60] [--drop-duration 150]
  <bench_dir>/<mode>/ ごとに:
    - th13.exe の CPU 時間(cpu.txt。utime+stime、秒)と、録画時間あたりの CPU 使用率
    - 落ちフレーム率(scripts/81、プレイ区間 --drop-start 以降 --drop-duration 秒)
    - FpsMonitor(リプレイ開始=MOD の "sequence complete" から 30 秒後以降の 5 秒窓)の中央値・下位5%・最低
    - 重複フレーム率(recorder の判定ログ)
  --timing を付けると、D3DXTiming の最後の累計(関数ごと)も並べる。
"""
import argparse, os, re, subprocess, sys
from datetime import datetime

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FPS_RE = re.compile(r"^\[(\d\d:\d\d:\d\d\.\d+)\] FpsMonitor:.*\(([\d.]+) Hz\)")
SEQ_RE = re.compile(r"^\[(\d\d:\d\d:\d\d\.\d+)\] === th13_replay_autoplay: sequence complete")
TIM_RE = re.compile(r"D3DXTiming: (\S+)\s+calls=\s*(\d+) total=\s*([\d.]+)ms avg=\s*([\d.]+)us max=\s*([\d.]+)us")


def t(s):
    return datetime.strptime(s, "%H:%M:%S.%f")


def fps_stats(log):
    seq, vals = None, []
    for line in open(log, encoding="utf-8", errors="replace"):
        m = SEQ_RE.match(line)
        if m:
            seq = t(m.group(1))
        m = FPS_RE.match(line)
        if m and seq and (t(m.group(1)) - seq).total_seconds() > 30:
            vals.append(float(m.group(2)))
    if not vals:
        return None
    vals.sort()
    return vals[len(vals) // 2], vals[int(len(vals) * 0.05)], vals[0], len(vals)


def drop_rate(video, start, duration):
    p = subprocess.run([sys.executable, f"{REPO}/scripts/81_analyze_stutter_periodicity.py", video,
                        "--start", str(start), "--duration", str(duration)], capture_output=True, text=True)
    out = p.stdout + p.stderr
    m = re.search(r"落ちたフレーム: \d+ \(([\d.]+)%\)", out)
    e = re.search(r"実効fps[^\d]*([\d.]+)", out)
    return (m.group(1) if m else "?"), (e.group(1) if e else "?"), out


def timing(log):
    last = {}
    for line in open(log, encoding="utf-8", errors="replace"):
        m = TIM_RE.search(line)
        if m:
            last[m.group(1)] = (int(m.group(2)), float(m.group(3)), float(m.group(4)), float(m.group(5)))
    return last


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("bench_dir")
    ap.add_argument("--timing", action="store_true")
    ap.add_argument("--drop-start", type=float, default=60)
    ap.add_argument("--drop-duration", type=float, default=150)
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args()
    modes = [m for m in ("builtin", "area", "native") if os.path.isdir(os.path.join(a.bench_dir, m))]
    print("| mode | CPU時間(s) / 経過(s) / 使用率 | 落ち率 / 実効fps | FpsMonitor 中央/下位5%/最低 (窓数) | 重複率 |")
    print("|---|---|---|---|---|")
    tims = {}
    for mode in modes:
        d = os.path.join(a.bench_dir, mode)
        cpu = open(f"{d}/cpu.txt").read().split() if os.path.exists(f"{d}/cpu.txt") else None
        if cpu:
            tick = int(cpu[3].split("=")[1]); cs = int(cpu[0]) / tick; el = int(cpu[1])
            cpu_s = f"{cs:.1f} / {el} / {cs / el * 100:.0f}%"
        else:
            cpu_s = "?"
        dr, ef, out = drop_rate(f"{d}/video.mp4", a.drop_start, a.drop_duration)
        if a.verbose:
            print(out, file=sys.stderr)
        fs = fps_stats(f"{d}/autoplay.log")
        fs_s = f"{fs[0]:.1f}/{fs[1]:.1f}/{fs[2]:.1f} ({fs[3]})" if fs else "?"
        dup = "?"
        for line in open(f"{d}/recorder.log", encoding="utf-8", errors="replace"):
            m = re.search(r"重複フレーム率[=:：]?\s*([\d.]+)%", line)
            if m:
                dup = m.group(1) + "%"
        print(f"| {mode} | {cpu_s} | {dr}% / {ef} | {fs_s} | {dup} |")
        if a.timing:
            tims[mode] = timing(f"{d}/autoplay.log")
    if a.timing:
        names = sorted({n for v in tims.values() for n in v})
        print()
        print("| 関数 | " + " | ".join(f"{m} 回数 / 合計ms / 平均us / 最大us" for m in modes) + " |")
        print("|---|" + "---|" * len(modes))
        for n in names:
            cells = []
            for m in modes:
                v = tims[m].get(n)
                cells.append(f"{v[0]} / {v[1]:.2f} / {v[2]:.2f} / {v[3]:.1f}" if v else "–")
            print(f"| {n} | " + " | ".join(cells) + " |")
        print()
        print("| mode | d3dx9 合計(ms) |")
        print("|---|---|")
        for m in modes:
            print(f"| {m} | {sum(v[1] for v in tims[m].values()):.1f} |")


if __name__ == "__main__":
    main()
