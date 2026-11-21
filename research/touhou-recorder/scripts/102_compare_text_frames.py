#!/usr/bin/env python3
"""フェーズ102: 文字の縮小フィルタ(D3DX_AREA_FILTER=1)の有無で録った2本の動画から、文字が出ている場面の
同じゲームフレームを探して並べる。

Usage: python3 scripts/102_compare_text_frames.py <area.mp4> <builtin.mp4> <out_dir> [--times 70,120,...]
         [--modlog area.modlog.txt --log area.log] [--max-scenes 6] [--scale 3]

- 場面の時刻(area 側の動画の秒)は --times で与えるか、area 側の MOD ログの
  `D3DXFilterHook: area-filtered` / `D3DXLoadSurfaceFromMemory: ... filter=0x4` の時刻(縮小転送=文字の更新)
  から自動で選ぶ(転送の 1.5 秒後。recorder ログの `video_start=` で動画の時刻へ直す)。
- builtin 側は、area 側のフレームと画面全体の平均絶対差が最小のフレームを、両動画のリプレイ開始のずれを
  見込んだ時刻の ±1.5 秒(30fps 刻み)から探す。リプレイは決定的なので、文字以外はほぼ一致する。
- 2 枚の差が閾値(輝度 24)を超える画素の外接矩形を「文字が変わった範囲」として、そこを --scale 倍に
  最近傍拡大して上下(上: builtin=現行、下: area)に並べた PNG と、全画面を左右に並べた PNG を書く。
- 標準出力に、場面ごとの時刻・画面全体の平均絶対差・中間階調率(輝度 48〜207 の画素の割合)を出す。
  背景のアニメーションは乱数でずれるタイトルがあるため、差の外接矩形は画面全体になりやすい。その場合は
  全画面の PNG を目視して、文字の範囲を --crop で指定し直す。
"""
import argparse, os, re, subprocess
from datetime import datetime

import numpy as np
from PIL import Image

W, H = 640, 480


def probe_size(video):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                          "-of", "csv=p=0", video], capture_output=True, text=True, check=True).stdout.strip()
    w, h = out.split(",")
    return int(w), int(h)


def frames(video, t0, dur, fps):
    w, h = probe_size(video)
    cmd = ["ffmpeg", "-loglevel", "error", "-ss", f"{max(0, t0):.3f}", "-t", f"{dur:.3f}", "-i", video,
           "-vf", f"fps={fps}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    n = len(raw) // (w * h * 3)
    return np.frombuffer(raw[: n * w * h * 3], np.uint8).reshape(n, h, w, 3), max(0, t0)


def log_epoch(path, key):
    if not path or not os.path.exists(path):
        return None
    m = None
    for line in open(path, errors="replace"):
        mm = re.search(key + r"=([\d.]+)", line)
        if mm:
            m = float(mm.group(1))
    return m


def transfer_times(modlog, day_epoch_base):
    """縮小転送のあった時刻(epoch)の一覧。MOD ログの時刻はローカル時刻の HH:MM:SS.mmm。"""
    ts = []
    for line in open(modlog, errors="replace"):
        if "area-filtered" in line or ("D3DXLoadSurfaceFromMemory" in line and "filter=0x4" in line):
            m = re.match(r"\[(\d+):(\d+):(\d+)\.(\d+)\]", line)
            if m:
                h, mi, s, ms = map(int, m.groups())
                ts.append(day_epoch_base + h * 3600 + mi * 60 + s + ms / 1000)
    return ts


def mid_ratio(g):
    return float(((g >= 48) & (g <= 207)).mean()) if g.size else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("area"); ap.add_argument("builtin"); ap.add_argument("out_dir")
    ap.add_argument("--times", default=None, help="area 側の動画の秒(カンマ区切り)")
    ap.add_argument("--modlog"); ap.add_argument("--log"); ap.add_argument("--builtin-log")
    ap.add_argument("--max-scenes", type=int, default=6)
    ap.add_argument("--max-time", type=float, default=None, help="builtin 側の長さなど、これより後の場面は使わない")
    ap.add_argument("--offset", type=float, default=None, help="builtin の時刻 = area の時刻 + offset(未指定なら推定)")
    ap.add_argument("--scale", type=int, default=3)
    ap.add_argument("--crop", action="append", default=[],
                    help="x,y,w,h。拡大して並べる範囲(複数可)。未指定なら差の外接矩形(背景のアニメーションが乱数で"
                         "ずれるタイトルでは画面全体になりやすい)")
    a = ap.parse_args()
    os.makedirs(a.out_dir, exist_ok=True)

    if a.times:
        times = [float(x) for x in a.times.split(",")]
    else:
        vstart = log_epoch(a.log, "video_start")
        d = datetime.fromtimestamp(vstart)
        base = datetime(d.year, d.month, d.day).timestamp()
        ts = sorted(t - vstart for t in transfer_times(a.modlog, base))
        # 近い転送(会話の数行・連続する台詞)はまとめ、場面の間を 20 秒以上あける
        times, last = [], -1e9
        for t in ts:
            if t - last >= 20:
                times.append(t + 1.5)
                last = t
        if a.max_time:
            times = [t for t in times if t < a.max_time - 3]
        if len(times) > a.max_scenes:
            idx = np.linspace(0, len(times) - 1, a.max_scenes).round().astype(int)
            times = [times[i] for i in sorted(set(idx))]

    offset = a.offset
    if offset is None:
        # 両方の録画の「動画開始 → MOD のリプレイ開始(sequence complete)」のずれ
        def seq(modlog, log):
            vs = log_epoch(log, "video_start")
            if vs is None or not modlog:
                return None
            d = datetime.fromtimestamp(vs); base = datetime(d.year, d.month, d.day).timestamp()
            for line in open(modlog, errors="replace"):
                if "sequence complete" in line:
                    h, mi, s, ms = map(int, re.match(r"\[(\d+):(\d+):(\d+)\.(\d+)\]", line).groups())
                    return base + h * 3600 + mi * 60 + s + ms / 1000 - vs
            return None
        sa = seq(a.modlog, a.log)
        bmod = a.builtin.rsplit(".", 1)[0] + ".modlog.txt"
        sb = seq(bmod if os.path.exists(bmod) else None, a.builtin_log or a.builtin.rsplit(".", 1)[0] + ".log")
        offset = (sb - sa) if (sa is not None and sb is not None) else 0.0
    print(f"offset(builtin - area) = {offset:+.2f}s, scenes = {[round(t, 1) for t in times]}")

    for k, t in enumerate(times):
        fa, ta0 = frames(a.area, t, 1 / 60 + 0.001, 60)
        if not len(fa):
            continue
        A = fa[0].astype(int)
        fb, tb0 = frames(a.builtin, t + offset - 1.5, 3.0, 60)
        best = None
        for i, f in enumerate(fb):
            d = np.abs(f.astype(int) - A).mean()
            if best is None or d < best[0]:
                best = (d, i)
        if best is None:
            continue
        B = fb[best[1]].astype(int)
        tb = tb0 + best[1] / 60
        ga, gb = A.mean(axis=2), B.mean(axis=2)
        diff = np.abs(ga - gb) > 24
        ys, xs = np.nonzero(diff)
        if len(xs):
            x0, x1, y0, y1 = max(0, xs.min() - 4), min(A.shape[1], xs.max() + 5), max(0, ys.min() - 4), min(A.shape[0], ys.max() + 5)
        else:
            x0, x1, y0, y1 = 0, 0, 0, 0
        outside = np.ones(diff.shape, bool); outside[y0:y1, x0:x1] = False
        out_mad = float(np.abs(A - B).mean(axis=2)[outside].mean())
        print(f"scene{k}: area t={t:.2f}s builtin t={tb:.2f}s full-frame MAD={best[0]:.2f} "
              f"text box=({x0},{y0})-({x1},{y1}) MAD outside box={out_mad:.2f} "
              f"mid-tone ratio in box: builtin={mid_ratio(gb[y0:y1, x0:x1]):.3f} area={mid_ratio(ga[y0:y1, x0:x1]):.3f}")
        Image.fromarray(np.concatenate([B, A], axis=1).astype(np.uint8)).save(f"{a.out_dir}/scene{k}_full_builtin_area.png")
        boxes = [tuple(map(int, c.split(","))) for c in a.crop] or ([(x0, y0, min(x1 - x0, 640), min(y1 - y0, 160))] if x1 > x0 else [])
        for j, (x0, y0, cw, ch) in enumerate(boxes):
            x1, y1 = x0 + cw, y0 + ch
            cb = Image.fromarray(B[y0:y1, x0:x1].astype(np.uint8)); ca = Image.fromarray(A[y0:y1, x0:x1].astype(np.uint8))
            s = a.scale
            cb = cb.resize((cb.width * s, cb.height * s), Image.NEAREST); ca = ca.resize((ca.width * s, ca.height * s), Image.NEAREST)
            img = Image.new("RGB", (cb.width, cb.height * 2 + 4), (255, 0, 255))
            img.paste(cb, (0, 0)); img.paste(ca, (0, cb.height + 4))
            img.save(f"{a.out_dir}/scene{k}_crop{j}_builtin_over_area.png")
            print(f"  crop{j} ({x0},{y0},{cw},{ch}): mid-tone ratio builtin={mid_ratio(gb[y0:y1, x0:x1]):.3f} "
                  f"area={mid_ratio(ga[y0:y1, x0:x1]):.3f}")


if __name__ == "__main__":
    main()
