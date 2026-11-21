#!/usr/bin/env python3
"""指定した場面の音声を、正常な録画(参照)と比べる(reports/108)。

旧録画の時刻 t を、映像の照合で参照の時刻へ、さらに新録画の時刻へ対応づけ、各場面の
前後(既定 -1〜+2秒)の音声について、参照との正規化相互相関(NCC、ずれ±0.3秒で最大)を
旧・新それぞれで求める。効果音が抜けていれば旧のNCCが低く、直っていれば新で上がる。
高域通過(既定3kHz)した音声でも同じ値を出す(BGMの低域に埋もれた効果音を見やすくする)。

場面の前後だけを切り出して読むので、長い動画でも速い。参照と旧録画の大まかなずれ(--ref-offset)は
`scripts/87_compare_timeline.py`のvideo_offから与える。

使い方:
  python3 scripts/108_compare_scenes.py REF.mp4 OLD.mp4 NEW.mp4 3:28,8:57,9:37 --ref-offset -13.0
時刻は旧録画(OLD)の mm:ss または秒。出力の ref・new 列は、視聴で比べるときの対応時刻。
"""
import argparse
import subprocess

import numpy as np

W, H, FPS, SR = 32, 24, 60, 16000


def parse_time(s):
    if ":" in s:
        m, sec = s.split(":")
        return int(m) * 60 + float(sec)
    return float(s)


def fmt(t):
    return f"{int(t // 60)}:{t % 60:05.2f}"


def load_video_window(path, t0, dur):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", f"{max(0.0, t0):.3f}", "-t", f"{dur:.3f}", "-i", path,
         "-vf", f"fps={FPS},scale={W}:{H},format=gray", "-f", "rawvideo", "-"],
        capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, H * W).astype(np.float32)


def load_audio_window(path, t0, dur, af=None):
    filters = (af + "," if af else "") + "aresample=first_pts=0"
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", f"{max(0.0, t0):.3f}", "-t", f"{dur:.3f}", "-i", path,
         "-vn", "-af", filters, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
        capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32)


def map_time(src, dst, t, approx, search, win=2.0):
    """src の t 秒の映像が dst の何秒にあるか。dst の approx±search を探す(MAD最小)。"""
    seg = load_video_window(src, t, win)
    lo = max(0.0, approx - search)
    region = load_video_window(dst, lo, 2 * search + win)
    n = len(seg)
    best = (None, np.inf)
    for j in range(0, len(region) - n + 1):
        mad = np.abs(region[j:j + n] - seg).mean()
        if mad < best[1]:
            best = (lo + j / FPS, mad)
    return best


def ncc(seg, region):
    n = len(seg)
    if n == 0 or len(region) < n or seg.std() < 1e-5:
        return float("nan")
    size = 1 << int(np.ceil(np.log2(len(region) + n)))
    corr = np.fft.irfft(np.fft.rfft(region, size) * np.conj(np.fft.rfft(seg, size)), size)
    corr = corr[:len(region) - n + 1]
    energy = np.sqrt(np.convolve(region ** 2, np.ones(n), "valid"))
    return float((corr / (energy * np.linalg.norm(seg) + 1e-9)).max())


def audio_ncc(a_path, ta, b_path, tb, before, after, af=None, lag=0.5):
    seg = load_audio_window(a_path, ta - before, before + after, af)
    region = load_audio_window(b_path, tb - before - lag, before + after + 2 * lag, af)
    return ncc(seg, region)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ref")
    ap.add_argument("old")
    ap.add_argument("new")
    ap.add_argument("times")
    ap.add_argument("--ref-offset", type=float, required=True,
                    help="参照の時刻 ≈ 旧録画の時刻 + この値(87_compare_timeline.pyのvideo_offの符号反転)")
    ap.add_argument("--new-offset", type=float, default=0.0, help="新録画の時刻 ≈ 参照の時刻 - ref_offset + この値")
    ap.add_argument("--search", type=float, default=3.0, help="映像の対応づけの探索範囲(±秒)")
    ap.add_argument("--before", type=float, default=1.0)
    ap.add_argument("--after", type=float, default=2.0)
    ap.add_argument("--highpass", type=float, default=3000.0)
    args = ap.parse_args()
    hp = f"highpass=f={args.highpass:g}"
    print(f"{'old':>9} {'ref':>9} {'new':>9} {'MAD(o→r,r→n)':>14}  "
          f"{'NCC old':>8} {'NCC new':>8}  {'HP old':>7} {'HP new':>7}", flush=True)
    for s in args.times.split(","):
        t = parse_time(s)
        r, mad1 = map_time(args.old, args.ref, t, t + args.ref_offset, args.search)
        n, mad2 = map_time(args.ref, args.new, r, r - args.ref_offset + args.new_offset, args.search)
        vals = [audio_ncc(args.old, t, args.ref, r, args.before, args.after),
                audio_ncc(args.new, n, args.ref, r, args.before, args.after),
                audio_ncc(args.old, t, args.ref, r, args.before, args.after, hp),
                audio_ncc(args.new, n, args.ref, r, args.before, args.after, hp)]
        print(f"{fmt(t):>9} {fmt(r):>9} {fmt(n):>9} {mad1:6.2f},{mad2:6.2f}  "
              f"{vals[0]:8.3f} {vals[1]:8.3f}  {vals[2]:7.3f} {vals[3]:7.3f}", flush=True)


if __name__ == "__main__":
    main()
