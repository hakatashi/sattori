#!/usr/bin/env python3
"""フェーズ101: FONT_PROBE_DUMP_DIR のダンプ(textout_<n>_{pre,post}.bin)を解析する。

Usage: python3 analyze_dib_dumps.py <dir> [--png out_prefix]
  TextOutA の前後で変わった画素の数と、変化後の値の種類(16bpp なら 0xF000 -> 0x0000 だけか、
  中間値があるか)を表示する。中間値が無ければ「文字の形はアルファの二値にしか残らない」。
ダンプ形式(mods/common/font_quality_hook.cpp DumpDib): DWORD x7 (w, h, bpp, stride, mask_r, mask_g, mask_b) + 画素。
"""
import argparse, glob, os, struct
import numpy as np


def load(path):
    b = open(path, "rb").read()
    w, h, bpp, stride, mr, mg, mb = struct.unpack("<7I", b[:28])
    if bpp != 16:
        raise SystemExit(f"{path}: bpp={bpp} は未対応")
    a = np.frombuffer(b[28:28 + stride * h], "<u2").reshape(h, stride // 2)[:, :w]
    return (w, h, bpp, mr, mg, mb), a


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir"); ap.add_argument("--png")
    a = ap.parse_args()
    for pre in sorted(glob.glob(os.path.join(a.dir, "textout_*_pre.bin"))):
        post = pre.replace("_pre.bin", "_post.bin")
        info, p = load(pre)
        _, q = load(post)
        ch = p != q
        n = int(ch.sum())
        vals, cnt = np.unique(q[ch], return_counts=True) if n else ([], [])
        before = np.unique(p[ch]) if n else []
        print(f"{os.path.basename(pre)[:10]} {info[0]}x{info[1]} masks={info[3]:#06x},{info[4]:#06x},{info[5]:#06x} "
              f"changed={n} before={[hex(v) for v in before][:6]} after={[(hex(v), int(c)) for v, c in zip(vals, cnt)][:10]}")
        if a.png and n:
            from PIL import Image
            ys, xs = np.nonzero(ch)
            crop = q[: ys.max() + 4, : xs.max() + 4]
            img = ((crop >> 12) & 15).astype(np.uint8) * 17
            Image.fromarray(img).save(f"{a.png}_{os.path.basename(pre)[:10]}.png")


if __name__ == "__main__":
    main()
