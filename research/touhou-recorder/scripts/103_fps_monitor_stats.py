#!/usr/bin/env python3
"""フェーズ103: MODログのFpsMonitor(5秒窓)から、リプレイ再生中の平均・下位5%・最小と最終スコアを出す。

Usage: scripts/103_fps_monitor_stats.py <modlog> [...]
再生中 = ScoreMonitorのstageが1以上になってから最後まで(末尾2窓は終了画面なので除く)。
"""
import re
import sys

for path in sys.argv[1:]:
    hz, playing, score = [], False, None
    for line in open(path, errors="replace"):
        m = re.search(r"ScoreMonitor: score=(\d+) stage=(\d+)", line)
        if m:
            if int(m.group(2)) >= 1:
                playing = True
            score = int(m.group(1))
        m = re.search(r"FpsMonitor: \d+ GetDeviceState calls in \d+ ms \(([0-9.]+) Hz\)", line)
        if m and playing:
            hz.append(float(m.group(1)))
    hz = hz[:-2]
    if not hz:
        print(f"{path}: FpsMonitorなし")
        continue
    s = sorted(hz)
    p5 = s[int(len(s) * 0.05)]
    print(f"{path.split('/')[-1]}: n={len(hz)} mean={sum(hz)/len(hz):.2f} p5={p5:.1f} min={s[0]:.1f} "
          f"final_score={score} (x10={score*10})")
