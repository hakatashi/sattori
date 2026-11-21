#!/usr/bin/env python3
"""フェーズ101: gdi_text_test.exe の出力(PGM)を、文字の高さごとの階調数で要約する。

Usage: python3 analyze_gdi_pgm.py <out.pgm> [<out2.pgm> ...]
  gdi_text_test.exe は height 12〜32 の各行を 36px 間隔で縦に並べる。各行の画素値の種類数を表示する
  (2 なら二値=AA なし、16 前後なら Wine の GGO_GRAY4 相当の AA、それ以上なら Windows の AA)。
"""
import sys
import numpy as np
from PIL import Image

for path in sys.argv[1:]:
    a = np.array(Image.open(path))
    levels = [len(np.unique(a[i * 36:(i + 1) * 36])) for i in range(21)]
    print(path)
    print("  height: " + " ".join(f"{12 + i:3d}" for i in range(21)))
    print("  levels: " + " ".join(f"{v:3d}" for v in levels))
