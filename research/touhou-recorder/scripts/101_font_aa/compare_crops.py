#!/usr/bin/env python3
"""フェーズ101: 録画動画から参照スクリーンショットと同じ場面のフレームを探し、文字部分のクロップを比較する。

Usage: python3 compare_crops.py <video.mp4> <out_prefix> [--ref-dir games/th13/replay]
  各シーン(69s/116s/202s)について、ユーザー提供の Wine スクリーンショット(th13_06_wine_<t>s.png)の同じ矩形と
  最も似ているフレームを t±4秒(10fps刻み)から探し、そのクロップを <out_prefix>_<t>s_crop.png に保存する。
  あわせて「縁の中間階調の画素の割合」(輝度 48〜207 の画素の比率)を Windows/Wine参照/動画で表示する。
"""
import argparse, subprocess, sys
import numpy as np
from PIL import Image

SCENES = {"69": (122, 281, 215, 19), "116": (183, 15, 229, 19), "202": (126, 83, 69, 22)}


def frames(video, t0, t1, fps=10):
    w, h = 640, 480
    cmd = ["ffmpeg", "-loglevel", "error", "-ss", str(t0), "-t", str(t1 - t0), "-i", video,
           "-vf", f"fps={fps}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    n = len(raw) // (w * h * 3)
    return np.frombuffer(raw[: n * w * h * 3], np.uint8).reshape(n, h, w, 3)


def mid_ratio(gray):
    return float(((gray >= 48) & (gray <= 207)).mean())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video"); ap.add_argument("out_prefix")
    ap.add_argument("--ref-dir", default="games/th13/replay")
    a = ap.parse_args()
    for t, (x, y, w, h) in SCENES.items():
        # *_crop.png は 69s の Wine だけ 1px 下(y=282)から切り出されていたため、フル画面の
        # スクリーンショットを同じ座標で切り出して基準にする。
        box = (x, y, x + w, y + h)
        ref = np.array(Image.open(f"{a.ref_dir}/th13_06_wine_{t}s.png").convert("L").crop(box)).astype(int)
        win = np.array(Image.open(f"{a.ref_dir}/th13_06_windows_{t}s.png").convert("L").crop(box)).astype(int)
        t0 = max(0, int(t) - 4)
        fr = frames(a.video, t0, int(t) + 4)
        best = None
        for i, f in enumerate(fr):
            c = np.array(Image.fromarray(f).convert("L").crop((x, y, x + w, y + h))).astype(int)
            d = np.abs(c - ref).mean()
            if best is None or d < best[0]:
                best = (d, i, f)
        d, i, f = best
        crop = Image.fromarray(f).crop((x, y, x + w, y + h))
        crop.save(f"{a.out_prefix}_{t}s_crop.png")
        g = np.array(crop.convert("L")).astype(int)
        print(f"{t}s: best t={t0 + i / 10:.1f}s diff_vs_wine_ref={d:.1f} diff_vs_windows={np.abs(g - win).mean():.1f} "
              f"mid-tone ratio: windows={mid_ratio(win):.3f} wine_ref={mid_ratio(ref):.3f} video={mid_ratio(g):.3f}")


if __name__ == "__main__":
    main()
