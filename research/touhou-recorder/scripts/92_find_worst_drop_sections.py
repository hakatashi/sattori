#!/usr/bin/env python3
"""配信版の落ちフレームが激しい区間を、基準の動画(等倍)と比べて特定する(フェーズ92)。

mpdecimateは動きの少ない場面(会話、リザルト)の重複も落ちとして数えるので、同じリプレイの基準動画と
1秒ごとのユニークフレーム数を比べ、対象でだけ落ちている区間を出す。カット位置の違いで生じる時間差は、
差分が最小になるオフセットを探して補正する。

Usage:
  python3 scripts/92_find_worst_drop_sections.py <対象.mp4> <基準.mp4> [--window 5] [--top 15]
"""
import argparse
import re
import subprocess


def unique_per_second(video):
    """1秒ごとのユニークフレーム数のリストと、動画の秒数を返す。"""
    p = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-i", video, "-vf", "mpdecimate,showinfo", "-an", "-f", "null", "-"],
        capture_output=True, text=True, errors="replace",
    )
    times = [float(m) for m in re.findall(r"pts_time:([0-9.]+)", p.stderr)]
    length = int(times[-1]) + 1
    counts = [0] * length
    for t in times:
        counts[int(t)] += 1
    return counts, times


def best_offset(target, base, search=60):
    """target[t] と base[t + offset] の差が最小になるオフセット(秒)。"""
    best = (None, 0)
    for offset in range(-search, search + 1):
        pairs = [(target[t], base[t + offset]) for t in range(len(target)) if 0 <= t + offset < len(base)]
        score = sum(abs(a - b) for a, b in pairs) / len(pairs)
        if best[0] is None or score < best[0]:
            best = (score, offset)
    return best[1]


def fmt(t):
    return f"{int(t) // 60:02d}:{int(t) % 60:02d}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("base")
    ap.add_argument("--window", type=int, default=5)
    ap.add_argument("--top", type=int, default=15)
    args = ap.parse_args()

    target, times = unique_per_second(args.target)
    base, _ = unique_per_second(args.base)
    offset = best_offset(target, base)
    print(f"オフセット: 基準 = 対象 {offset:+d}秒")
    print(f"全体: ユニーク {len(times)} / {len(target)}秒, 平均 {len(times) / len(target):.2f}/秒")

    w = args.window
    rows = []
    for t in range(0, len(target) - w):
        cur = sum(target[t:t + w]) / w
        ref_slice = base[max(0, t + offset):max(0, t + offset + w)]
        ref = sum(ref_slice) / len(ref_slice) if ref_slice else 0
        rows.append((ref - cur, t, cur, ref))

    # 重ならないように差の大きい順に選ぶ
    chosen = []
    for row in sorted(rows, reverse=True):
        if all(abs(row[1] - c[1]) >= w for c in chosen):
            chosen.append(row)
        if len(chosen) == args.top:
            break
    print(f"\n基準より落ちている区間(窓{w}秒、差の大きい順)")
    print("| 位置 | 対象 ユニーク/秒 | 基準 ユニーク/秒 | 差 | 1秒ごとの対象 |")
    print("|---|---|---|---|---|")
    for diff, t, cur, ref in chosen:
        print(f"| {fmt(t)}〜{fmt(t + w)} | {cur:.1f} | {ref:.1f} | {diff:.1f} | {target[t:t + w]} |")

    low = sorted(rows, key=lambda r: r[2])
    chosen = []
    for row in low:
        if all(abs(row[1] - c[1]) >= w for c in chosen):
            chosen.append(row)
        if len(chosen) == args.top:
            break
    print(f"\n対象のユニークフレームが少ない区間(演出を含む。窓{w}秒、少ない順)")
    print("| 位置 | 対象 ユニーク/秒 | 基準 ユニーク/秒 |")
    print("|---|---|---|")
    for _, t, cur, ref in chosen:
        print(f"| {fmt(t)}〜{fmt(t + w)} | {cur:.1f} | {ref:.1f} |")

    gaps = sorted(((b - a, a) for a, b in zip(times, times[1:])), reverse=True)[:args.top]
    print("\n最大の停止(対象)")
    print("| 位置 | 停止(フレーム@60fps) |")
    print("|---|---|")
    for gap, t in gaps:
        print(f"| {fmt(t)} ({t:.2f}s) | {round(gap * 60)} |")


if __name__ == "__main__":
    main()
