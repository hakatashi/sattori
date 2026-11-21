#!/usr/bin/env python3
"""フェーズ97: 配信版の60秒窓ごとの重複フレーム率(%)を1行で出す。Usage: python3 scripts/97_dup_windows.py <video>"""
import sys, subprocess, numpy as np
path = sys.argv[1]; W, H = 160, 90
p = subprocess.Popen(["ffmpeg", "-v", "error", "-i", path, "-vf", f"scale={W}:{H},format=gray", "-f", "rawvideo", "-"], stdout=subprocess.PIPE)
prev = None; dup = []; n = 0
while True:
    b = p.stdout.read(W * H)
    if len(b) < W * H: break
    f = np.frombuffer(b, np.uint8).astype(np.int16)
    if prev is not None: dup.append(np.abs(f - prev).mean() < 0.02)
    prev = f
dup = np.array(dup)
win = 60 * 60
print(path.split("/")[-1], " ".join(f"{100*dup[i:i+win].mean():.0f}" for i in range(0, len(dup), win)))
