"""framesync._monitor_until_end() のテンプレート照合と同じ間隔・連続回数を、残ったサブ出力に当てる。
サブ出力のSAMPLE_INTERVAL_VIDEO_SEC(2秒)ごと、再生開始(start_number)から15秒の猶予のあと、2回連続で閾値未満なら終了。
usage: python3 -I simulate.py <pollstream.raw> <start_number> <unthrottle_frame> <replay_frames> <template> <maskname> <threshold>"""
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from masks import MASKS  # noqa: E402
from poll import load  # noqa: E402

raw, sn, uf, rf, tp, mk, thr = sys.argv[1:8]
sn, uf, rf, thr = int(sn), int(uf), int(rf), float(thr)
f = load(raw)
t = np.load(tp) if tp.endswith(".npy") else np.asarray(Image.open(tp).convert("L").resize((160, 120)), dtype=np.float32)
m = MASKS[mk]()
n, cons, streak = sn + 15 * 8, 0, None
while n < len(f):
    d = np.mean(np.abs(f[n] - t)[m])
    if d < thr:
        if cons == 0:
            streak = n
        cons += 1
    else:
        cons = 0
    if cons >= 2:
        break
    n += 16
theo = (uf + rf) / 60
if cons >= 2:
    print(f"detected at video {n/8:.1f}s content_end={streak/8:.1f}s theoretical_end={theo:.1f}s diff={streak/8-theo:+.1f}s")
else:
    print("not detected")
