#!/usr/bin/env python3
"""`scripts/49_stage_probe_run.py`が収集したMODログ(StageProbe行)を解析する。

3つの観点でレポートする:

1. MEM: アドレスごとに「観測された値の変化列」を再構成し、ステージ番号らしい
   もの(単調増加・値域が小さい・変化回数が少ない)を抽出する。
2. IO(BGM): thbgm.datの読み出しオフセットが不連続にジャンプした箇所を
   「BGMトラック切り替え」として列挙する。
3. IO(データアーカイブ): th0X.dat等の読み出しを時間窓でまとめ、バイト数の
   大きいバーストを「アセットロード」として列挙する。
"""

import argparse
import re
from collections import defaultdict

MEM_RE = re.compile(
    r"StageProbe: MEM t=([\d.]+) frame=(-?\d+) addr=0x([0-9a-f]+) \(([^)]*)\) (\d+)->(\d+) changes=(\d+)"
)
IO_RE = re.compile(
    r"StageProbe: IO t=([\d.]+) frame=(-?\d+) file=(\S+) reads=(\d+) bytes=(-?\d+) seeks=(\d+) "
    r"off_first=(-?\d+) off_last=(-?\d+)"
)


def fmt(t):
    return f"{int(t // 60):02d}:{t % 60:05.2f}"


def analyze_mem(lines, args):
    series = defaultdict(list)   # addr -> [(t, frame, old, new)]
    desc = {}
    for line in lines:
        m = MEM_RE.search(line)
        if not m:
            continue
        t, frame, addr, d, old, new, ch = m.groups()
        series[addr].append((float(t), int(frame), int(old), int(new)))
        desc[addr] = d

    print(f"=== MEM: 変化が記録されたアドレス数 = {len(series)}")
    cands = []
    for addr, evs in series.items():
        if not (args.min_events <= len(evs) <= args.max_events):
            continue
        # 単調増加(値のラップアラウンドを除外)かつ全ての値が小さい
        if any(new != old + 1 for _t, _f, old, new in evs):
            continue
        if any(new > args.max_value for _t, _f, _o, new in evs):
            continue
        # 連続した値の並び(1->2, 2->3, ...)になっていること
        ok = all(evs[i][3] == evs[i + 1][2] for i in range(len(evs) - 1))
        if not ok:
            continue
        cands.append((addr, evs))

    cands.sort(key=lambda x: (len(x[1]), x[0]))
    print(f"=== MEM: ステージ番号らしい候補 = {len(cands)} 件 "
          f"(events {args.min_events}..{args.max_events}, value<= {args.max_value})")
    for addr, evs in cands[: args.top]:
        seq = " ".join(f"{o}->{n}@{fmt(t)}" for t, _f, o, n in evs)
        print(f"  0x{addr} ({desc[addr]}) : {seq}")
    return cands


def analyze_io(lines, args):
    bgm = []
    arch = defaultdict(list)
    for line in lines:
        m = IO_RE.search(line)
        if not m:
            continue
        t, frame, f, reads, nbytes, seeks, off_first, off_last = m.groups()
        rec = (float(t), int(frame), int(reads), int(nbytes), int(seeks),
               int(off_first), int(off_last))
        if f.startswith("thbgm"):
            bgm.append(rec)
        elif f.endswith(".dat") and not f.startswith("score"):
            arch[f].append(rec)

    print("\n=== IO: thbgm.dat の読み出しオフセット不連続(BGMトラック切り替え候補)")
    prev_end = None
    for t, frame, reads, nbytes, seeks, off_first, off_last in bgm:
        if prev_end is not None and abs(off_first - prev_end) > args.bgm_jump:
            print(f"  t={fmt(t)} frame={frame} offset {prev_end} -> {off_first} "
                  f"(jump {off_first - prev_end:+d}) bytes={nbytes} seeks={seeks}")
        prev_end = off_last + (nbytes // max(1, reads))

    for f, recs in arch.items():
        print(f"\n=== IO: {f} の読み出しバースト(窓ごとの合計 >= {args.burst_bytes} bytes)")
        # 連続する窓(250ms刻み)をまとめる
        bursts = []
        cur = None
        for t, frame, reads, nbytes, seeks, off_first, off_last in recs:
            if cur and t - cur["t_end"] <= args.burst_gap:
                cur["t_end"] = t
                cur["bytes"] += nbytes
                cur["reads"] += reads
                cur["seeks"] += seeks
            else:
                if cur:
                    bursts.append(cur)
                cur = {"t0": t, "t_end": t, "bytes": nbytes, "reads": reads,
                       "seeks": seeks, "frame": frame}
        if cur:
            bursts.append(cur)
        for b in bursts:
            if b["bytes"] >= args.burst_bytes:
                print(f"  t={fmt(b['t0'])}..{fmt(b['t_end'])} frame={b['frame']} "
                      f"bytes={b['bytes']} reads={b['reads']} seeks={b['seeks']}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("logfile")
    ap.add_argument("--min-events", type=int, default=1)
    ap.add_argument("--max-events", type=int, default=8)
    ap.add_argument("--max-value", type=int, default=20)
    ap.add_argument("--top", type=int, default=60)
    ap.add_argument("--bgm-jump", type=int, default=1_000_000)
    ap.add_argument("--burst-bytes", type=int, default=100_000)
    ap.add_argument("--burst-gap", type=float, default=1.0)
    ap.add_argument("--skip-mem", action="store_true")
    ap.add_argument("--skip-io", action="store_true")
    args = ap.parse_args()

    with open(args.logfile, errors="replace") as f:
        lines = f.readlines()
    if not args.skip_mem:
        analyze_mem(lines, args)
    if not args.skip_io:
        analyze_io(lines, args)


if __name__ == "__main__":
    main()
