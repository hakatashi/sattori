#!/usr/bin/env python3
"""フェーズ101: D3DX_DUMP_DIR のダンプ(d3dx_<n>_{src,dst}.bin)を2組比較する。

Usage: python3 compare_xfer_dumps.py <dirA> <dirB> [--png out_prefix]
  転送元(src)の中身が同じ転送どうしを対応させ、転送先(dst)のアルファ(A4R4G4B4 は上位4bit、
  A8R8G8B8 は上位8bit。0〜255 に正規化)を比べる。平均絶対差・最大差・一致率と、
  アルファの階調数を表示する。--png を付けると src(縮小前)/A/B/差 を並べた画像を書き出す。
ダンプ形式(mods/common/d3dx_filter_hook.cpp DumpTransfer): DWORD x4 (w, h, D3DFORMAT, bpp) + 行を詰めた画素。
"""
import argparse, glob, hashlib, os, struct
import numpy as np


def load(path):
    b = open(path, "rb").read()
    w, h, fmt, bpp = struct.unpack("<4I", b[:16])
    raw = b[16:16 + w * h * bpp]
    if bpp == 2:
        px = np.frombuffer(raw, "<u2").reshape(h, w)
        alpha = ((px >> 12) & 15).astype(np.int32) * 17 if fmt == 26 else np.full((h, w), 255)
    elif bpp == 4:
        px = np.frombuffer(raw, "<u4").reshape(h, w)
        alpha = ((px >> 24) & 255).astype(np.int32)
    else:
        px = np.frombuffer(raw, "u1").reshape(h, w)
        alpha = px.astype(np.int32)
    return w, h, fmt, raw, alpha


def collect(d):
    out = {}
    for s in sorted(glob.glob(os.path.join(d, "d3dx_*_src.bin"))):
        dst = s.replace("_src.bin", "_dst.bin")
        if not os.path.exists(dst):
            continue
        sw, sh, sf, sraw, sa = load(s)
        key = hashlib.sha1(sraw).hexdigest()[:12]
        out.setdefault(key, (s, dst, sa, load(dst)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("a"); ap.add_argument("b"); ap.add_argument("--png")
    a = ap.parse_args()
    A, B = collect(a.a), collect(a.b)
    common = [k for k in A if k in B]
    print(f"A: {len(A)} transfers, B: {len(B)} transfers, same source: {len(common)}")
    for i, k in enumerate(common):
        sa_path, da_path, src_alpha, (w, h, f, _, aa) = A[k]
        _, db_path, _, (w2, h2, f2, _, ab) = B[k]
        if (w, h) != (w2, h2):
            print(f"{k}: size differs {w}x{h} vs {w2}x{h2}")
            continue
        d = np.abs(aa - ab)
        print(f"{os.path.basename(da_path)} vs {os.path.basename(db_path)}: {src_alpha.shape[1]}x{src_alpha.shape[0]} -> {w}x{h} "
              f"alpha levels A={len(np.unique(aa))} B={len(np.unique(ab))} mean|diff|={d.mean():.2f} max={d.max()} "
              f"exact={float((d == 0).mean()):.3f} within1step(17)={float((d <= 17).mean()):.3f}")
        if a.png:
            from PIL import Image
            s = 4
            sh_, sw_ = src_alpha.shape
            rows = [Image.fromarray((255 - src_alpha).astype(np.uint8)).resize((w * s, h * s), Image.NEAREST)]
            for img in (aa, ab, np.clip(d * 4, 0, 255)):
                v = img if img is d else 255 - img
                rows.append(Image.fromarray(np.clip(v, 0, 255).astype(np.uint8)).resize((w * s, h * s), Image.NEAREST))
            c = Image.new("L", (w * s, sum(r.height + 4 for r in rows)), 128)
            y = 0
            for r in rows:
                c.paste(r, (0, y)); y += r.height + 4
            c.save(f"{a.png}_{i:02d}.png")


if __name__ == "__main__":
    main()
