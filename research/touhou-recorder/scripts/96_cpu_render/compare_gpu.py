#!/usr/bin/env python3
"""CPU録画とGPU録画の同じ場面を探し、描画の差をPSNRで比べる(reports/96)。"""
import subprocess, sys
import numpy as np

def frames(path, start, dur, w=1280, h=720):
    cmd = ["ffmpeg", "-nostdin", "-loglevel", "error", "-ss", str(start), "-i", path, "-t", str(dur), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    d = subprocess.run(cmd, capture_output=True).stdout
    return np.frombuffer(d, np.uint8).reshape(-1, h, w, 3)

cpu, gpu = sys.argv[1], sys.argv[2]
for t in [int(x) for x in sys.argv[3:]]:
    a = frames(cpu, t, 0.05)[0].astype(np.float32)
    g = frames(gpu, t - 6, 12)
    # プレイフィールド外(左右パネル)は透かし・スコア桁を含むので、全画面で最良一致を探す
    mad = np.abs(g[:, ::4, ::4].astype(np.float32) - a[::4, ::4]).mean(axis=(1, 2, 3))
    i = int(mad.argmin())
    b = g[i].astype(np.float32)
    psnr = lambda x, y: 10 * np.log10(255 ** 2 / max(((x - y) ** 2).mean(), 1e-9))
    left, right, field = (0, 352), (934, 1280), (352, 934)
    print(f"t={t} best={t-6+i/60:.2f}s full={psnr(a,b):.1f}dB left={psnr(a[:,:352],b[:,:352]):.1f} field={psnr(a[:,352:934],b[:,352:934]):.1f} right={psnr(a[:,934:],b[:,934:]):.1f}")
    if t == int(sys.argv[3]):
        from PIL import Image
        Image.fromarray(np.vstack([a, b]).astype(np.uint8)).resize((960, 1080)).save(sys.argv[1] + f".cmp{t}.png")
