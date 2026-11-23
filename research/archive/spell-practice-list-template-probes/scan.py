"""誤検知の走査: 完成済みの録画(mp4)を8fps・160x120グレーへ落とし、全フレームとテンプレートのマスク付きMADを出す。
usage: python3 -I scan.py <template.npy|.png> <maskname> <video...>
環境変数 SKIP(秒、既定25): 「再生開始後」の最小値を出すときに飛ばす先頭(リプレイ開始前の一覧画面を除くため)。"""
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from masks import MASKS  # noqa: E402
from poll import decode  # noqa: E402

p = sys.argv[1]
tmpl = np.load(p) if p.endswith(".npy") else np.asarray(
    Image.open(p).convert("L").resize((160, 120)), dtype=np.float32)
m = MASKS[sys.argv[2]]()
skip = int(float(os.environ.get("SKIP", "25")) * 8)
for v in sys.argv[3:]:
    f = decode(v)
    d = np.array([np.mean(np.abs(x - tmpl)[m]) for x in f])
    low = np.where(d < 15)[0]
    dd = d[skip:]
    print(v, f"n={len(f)} dur={len(f)/8:.0f}s min={d.min():.2f}@{d.argmin()/8:.1f}s "
          f"after{skip/8:.0f}s_min={dd.min():.2f}@{(dd.argmin()+skip)/8:.1f}s below15={len(low)}",
          ("first<15 at %.1fs last<15 at %.1fs" % (low[0] / 8, low[-1] / 8)) if len(low) else "")
