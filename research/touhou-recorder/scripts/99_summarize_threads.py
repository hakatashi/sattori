#!/usr/bin/env python3
"""99_thread_sampler.pyの出力を、FpsMonitorの低い区間と高い区間に分けてスレッド別に集計する(reports/99)。

使い方: scripts/99_summarize_threads.py <threads.tsv> [--from 秒] [--to 秒]

llvmpipe-N・lavapipe-N等の番号付きスレッドは名前の数字を除いてまとめ、合計と最大を出す。
"""
import argparse
import collections
import re

ap = argparse.ArgumentParser()
ap.add_argument("tsv")
ap.add_argument("--from", dest="t0", type=float, default=0)
ap.add_argument("--to", dest="t1", type=float, default=1e9)
a = ap.parse_args()

per_t = collections.defaultdict(list)  # 時刻 -> [(tid, comm, pct)]
for line in open(a.tsv):
    if line.startswith("#"):
        continue
    t, tid, comm, pct = line.rstrip("\n").split("\t")
    t = float(t)
    if a.t0 <= t <= a.t1:
        per_t[t].append((int(tid), comm, float(pct)))

n = len(per_t)
tot = collections.defaultdict(float)   # (tid, comm) -> 合計%
for rows in per_t.values():
    for tid, comm, pct in rows:
        tot[(tid, comm)] += pct
print(f"samples={n}")
groups = collections.defaultdict(list)
for (tid, comm), s in tot.items():
    groups[re.sub(r"[-:]?\d+$", "", comm)].append(s / n)
print(f"{'group':24s} {'threads':>7s} {'sum%':>8s} {'max1%':>8s}")
for g, v in sorted(groups.items(), key=lambda kv: -sum(kv[1])):
    print(f"{g:24s} {len(v):7d} {sum(v):8.1f} {max(v):8.1f}")
print("--- top threads (mean %)")
for (tid, comm), s in sorted(tot.items(), key=lambda kv: -kv[1])[:8]:
    print(f"{tid:8d} {comm:24s} {s / n:6.1f}")
