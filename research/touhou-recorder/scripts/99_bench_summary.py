#!/usr/bin/env python3
"""99_bench.shのFpsMonitorを、ゲーム内時間(累積フレーム数)の区間ごとに集計する(reports/99)。

使い方: scripts/99_bench_summary.py <autoplay.log> [区間フレーム数(既定3600=ゲーム内1分)] [最大フレーム数]

最大フレーム数を渡すと、それ以降(リプレイ終了後の画面など)を集計から外す。

倍速で回すと実時間ではなく処理したフレーム数で場面が決まるため、累積フレーム数で区切って
条件間を比べる。出力は区間ごとの平均Hz(=その場面で1秒に描けたフレーム数)。
リプレイ再生が始まる前(メニュー)も含む点に注意(先頭1〜2区間)。
"""
import re
import sys

log = sys.argv[1]
binf = int(sys.argv[2]) if len(sys.argv) > 2 else 3600
maxf = int(sys.argv[3]) if len(sys.argv) > 3 else None
rows = []
for line in open(log, errors="ignore"):
    m = re.search(r"FpsMonitor: (\d+) \S+ calls in (\d+) ms", line)
    if m:
        rows.append((int(m.group(1)), int(m.group(2))))
        if maxf and sum(n for n, _ in rows) >= maxf:
            break
if not rows:
    print("NO DATA")
    sys.exit(1)
cum = 0
bins = {}
for n, ms in rows:
    b = cum // binf
    f, t = bins.get(b, (0, 0))
    bins[b] = (f + n, t + ms)
    cum += n
hz_all = sorted(n * 1000 / ms for n, ms in rows if ms)
tot_f = sum(n for n, _ in rows)
tot_ms = sum(ms for _, ms in rows)
print(f"windows={len(rows)} frames={tot_f} mean={tot_f * 1000 / tot_ms:.1f}Hz "
      f"p5={hz_all[len(hz_all) // 20]:.1f} min={hz_all[0]:.1f} "
      f"wall={tot_ms / 1000:.0f}s lt60={sum(h < 60 for h in hz_all)} lt45={sum(h < 45 for h in hz_all)}")
print("bin(min) " + " ".join(f"{b:5d}" for b in sorted(bins)))
print("Hz       " + " ".join(f"{f * 1000 / t:5.0f}" for b, (f, t) in sorted(bins.items())))
