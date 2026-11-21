#!/usr/bin/env python3
"""録画動画の「コマ落ち(重複フレーム)」の量と周期性を解析する(フェーズ81)。

`scripts/measure_duplicate_frame_rate.sh` は区間の重複フレーム率(割合)しか出さないため、
「数秒ごとに数フレーム飛ぶ」タイプの体感的なカクつきを定量化できない。本スクリプトは
mpdecimate が残したフレームのタイムスタンプ列から

  * 実効fps(= 実際にユニークな絵が何コマ/秒あったか)
  * コマ落ちバーストの回数・1回あたりの落ちフレーム数
  * 落ちるタイミングの周期性(位相集中度 R)と、最も当てはまる周期

を求める。Rが大きい周期が見つかる場合、その周期で動く「何か」が録画を妨害している。

フェーズ81では、AWS g6f.xlarge 上の th06nc 録画で R=0.654 / 周期2.32秒 が検出され、
これが `scripts/25` の終了検知ポーリング(POLL_INTERVAL_SEC=2.0秒 + grab_frame 約0.32秒)
と一致したことから、原因を特定できた。

Usage:
  python3 scripts/81_analyze_stutter_periodicity.py <video> [--start 300] [--duration 120]
"""
import argparse
import math
import re
import subprocess
import sys
from collections import Counter

PTS_RE = re.compile(r"pts_time:([0-9.]+)")


def kept_frame_times(video, start, duration):
    """mpdecimate を通した後に残ったフレームの pts_time 列を返す。

    showinfo は INFO レベルで出力するので -v error を付けてはいけない(付けると
    1件も取れず「解析できているつもりで空」になる)。
    """
    cmd = ["ffmpeg", "-hide_banner", "-ss", str(start), "-t", str(duration),
           "-i", video, "-vf", "mpdecimate,showinfo", "-an", "-f", "null", "-"]
    p = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
    ts = [float(m) for m in PTS_RE.findall(p.stderr)]
    ts.sort()
    return ts


def phase_concentration(times, period):
    """各イベント時刻を period で畳んだときの位相集中度 R(0=無相関, 1=完全同位相)。"""
    if not times:
        return 0.0
    c = sum(math.cos(2 * math.pi * (t % period) / period) for t in times) / len(times)
    s = sum(math.sin(2 * math.pi * (t % period) / period) for t in times) / len(times)
    return math.hypot(c, s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--start", type=float, default=60.0, help="解析開始位置(秒)")
    ap.add_argument("--duration", type=float, default=120.0, help="解析する長さ(秒)")
    ap.add_argument("--fps", type=float, default=60.0)
    ap.add_argument("--burst-gap", type=float, default=0.5,
                    help="この秒数以内に続く落ちは1つのバーストとしてまとめる")
    ap.add_argument("--period-min", type=float, default=1.0)
    ap.add_argument("--period-max", type=float, default=5.0)
    ap.add_argument("--list-bursts", action="store_true",
                    help="カクつきの発生時刻を一覧表示する(目視確認用。元動画先頭からの絶対秒)")
    args = ap.parse_args()

    ts = kept_frame_times(args.video, args.start, args.duration)
    if len(ts) < 2:
        print("ERROR: フレームのタイムスタンプを取得できませんでした", file=sys.stderr)
        return 1
    span = ts[-1] - ts[0]
    frame = 1.0 / args.fps

    events = []
    for a, b in zip(ts, ts[1:]):
        n = round((b - a) / frame) - 1
        if n >= 1:
            events.append((a, n))

    bursts = []
    for t, n in events:
        if bursts and t - bursts[-1][0] < args.burst_gap:
            bursts[-1] = (bursts[-1][0], bursts[-1][1] + n)
        else:
            bursts.append((t, n))

    dropped = sum(n for _, n in events)
    print(f"動画          : {args.video}")
    print(f"解析区間      : 元動画の {args.start:.0f}s から {span:.1f}秒間")
    print(f"ユニークフレーム: {len(ts)}  落ちたフレーム: {dropped} "
          f"({dropped / (len(ts) + dropped) * 100:.1f}%)")
    print(f"実効fps       : {len(ts) / span:.2f}  (理想 {args.fps:.0f})")
    if not bursts:
        print("コマ落ちは検出されませんでした")
        return 0
    print(f"カクつきバースト: {len(bursts)}回 / {span:.0f}秒 "
          f"(平均間隔 {span / len(bursts):.2f}秒)")
    print(f"1バーストの落ちフレーム数: 平均 {dropped / len(bursts):.1f}  最大 {max(n for _, n in bursts)}")
    print(f"落ちフレーム数の分布: {dict(sorted(Counter(n for _, n in bursts).items()))}")

    if args.list_bursts:
        print()
        print("カクつき発生時刻(元動画先頭からの絶対時刻。mm:ss.s も併記):")
        for t, n in bursts:
            abs_t = args.start + t
            m, sec = divmod(abs_t, 60)
            print(f"  {abs_t:8.2f}s  ({int(m):02d}:{sec:04.1f})  {n}フレーム脱落 "
                  f"({n / args.fps * 1000:.0f}ms相当)")
        print()

    bt = [t for t, _ in bursts]
    best = max(((p / 100.0, phase_concentration(bt, p / 100.0))
                for p in range(int(args.period_min * 100), int(args.period_max * 100) + 1)),
               key=lambda x: x[1])
    # バーストが少ないとどんな周期にも当てはめられてしまう(2〜3個ならR=1.0が
    # 簡単に出る)。周期性を語るには最低限の母数が要る。
    MIN_BURSTS_FOR_PERIODICITY = 8
    if len(bursts) < MIN_BURSTS_FOR_PERIODICITY:
        print(f"周期性: 判定不能(バーストが{len(bursts)}回しかなく、"
              f"{MIN_BURSTS_FOR_PERIODICITY}回未満では任意の周期に当てはまってしまう)")
        print("  -> この規模ならキャプチャ起因の周期的なカクつきは実質無い。"
              "残っているバーストは演出上の静止画面(ボス前会話・リザルト・エンディング)の"
              "可能性が高いので、--list-bursts の時刻を動画で目視確認すること")
        return 0
    print(f"最も当てはまる周期: {best[0]:.2f}秒 (位相集中度 R={best[1]:.3f})")
    if best[1] >= 0.3:
        print("  -> 強い周期性あり。この周期で動く処理が録画を妨害している疑いが濃厚")
    else:
        print("  -> 目立った周期性は無い(散発的な取りこぼし、または演出上の静止画面)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
