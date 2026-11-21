#!/usr/bin/env python3
"""フェーズ103: th14の録画結果を、AGENTS.mdの品質判定基準①〜④に沿って1行ずつ集計する。

Usage:
  python3 scripts/103_summarize.py --restored DIR --frames 46042 --score 160711180 DIR/label:hz [DIR/label:hz ...]

  hz は録画時のゲーム速度(60=等倍、30=1/2倍速、20=1/3倍速、120=2倍速)。
  等倍以外は scripts/47_descale_th20_slowmo.py で等倍(60fps)へ戻した動画を --restored に作り(既にあれば
  使い回す)、その動画のプレイ区間を scripts/81_analyze_stutter_periodicity.py で数える(基準①)。

列:
  ① 落ち率(全体)と、30秒窓で最悪の落ち率
  ② FpsMonitor(再生中)の平均・下位5%・最小と、目標Hz×0.97に対する合否
  ③ 理論尺比: MODログで stage>=1 を初めて見た時刻から最後にスコアが変わった時刻までを
     ゲーム内時間(×hz/60)に直し、frames/60 と比べる(ScoreMonitorが1秒間隔なので±1〜2秒の粗さ)
  ④ 同期マーカーのmux後残差
  スコア一致、録画の総実時間
"""
import argparse
import os
import re
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
PTS_RE = re.compile(r"pts_time:([0-9.]+)")


def modlog_stats(path):
    hz, playing, score, t_first, t_last, last_score = [], False, None, None, None, None
    for line in open(path, errors="replace"):
        m = re.search(r"ScoreMonitor: score=(\d+) stage=(\d+).*epoch_ms=(\d+)", line)
        if m:
            s, st, t = int(m.group(1)), int(m.group(2)), int(m.group(3)) / 1000
            if st >= 1 and t_first is None:
                playing, t_first = True, t
            if playing and s != last_score:
                last_score, t_last = s, t
            score = s
        m = re.search(r"FpsMonitor: \d+ GetDeviceState calls in \d+ ms \(([0-9.]+) Hz\)", line)
        if m and playing:
            hz.append(float(m.group(1)))
    hz = hz[:-2] if len(hz) > 4 else hz
    return hz, score, (t_last - t_first if t_first and t_last else None)


def unique_times(video, start, duration):
    p = subprocess.run(["ffmpeg", "-hide_banner", "-ss", str(start), "-t", str(duration), "-i", video,
                        "-vf", "mpdecimate,showinfo", "-an", "-f", "null", "-"],
                       capture_output=True, text=True, errors="replace")
    return [float(m) for m in PTS_RE.findall(p.stderr)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--restored", required=True)
    ap.add_argument("--frames", type=int, required=True, help="リプレイのframeCount(replay-parser)")
    ap.add_argument("--score", type=int, required=True, help="リプレイの記録スコア(表示値)")
    ap.add_argument("--head", type=float, default=30.0, help="解析から外す先頭の秒数(等倍換算)")
    ap.add_argument("items", nargs="+")
    args = ap.parse_args()
    os.makedirs(args.restored, exist_ok=True)
    print("| label | 速度 | ①落ち率(実効fps) | ①30秒窓の最悪 | ②FpsMonitor 平均/下位5%/最小 | ②判定 "
          "| ③理論尺比 | ④同期残差 | スコア | 総録画時間 |")
    print("|" + "---|" * 10)
    for item in args.items:
        base, hz = item.rsplit(":", 1)
        hz = float(hz)
        label = os.path.basename(base)
        video = f"{base}.mp4"
        if hz != 60:
            restored = f"{args.restored}/{label}_restored.mp4"
            if not os.path.exists(restored):
                subprocess.run(["python3", f"{HERE}/47_descale_th20_slowmo.py", video, restored,
                                "--target-hz", str(hz)], capture_output=True, check=True)
            video = restored
        play = args.frames / 60.0
        # 先頭head秒(メニュー〜ステージ冒頭)を外し、リプレイのプレイ区間だけを見る。
        # 動画の先頭にはメニュー操作(等倍換算で約15秒)があるので、その後ろからplay秒ぶん。
        start, dur = 15 + args.head, play - args.head - 5
        ts = unique_times(video, start, dur)
        if len(ts) > 1:
            span = ts[-1] - ts[0]
            ideal = span * 60
            drop = max(0.0, 1 - (len(ts) - 1) / ideal)
            worst = 0.0
            t0 = ts[0]
            while t0 + 30 <= ts[-1]:
                n = sum(1 for t in ts if t0 <= t < t0 + 30)
                worst = max(worst, 1 - n / 1800.0)
                t0 += 10
            c1 = f"{drop * 100:.1f}% ({(len(ts) - 1) / span:.2f})"
            c1w = f"{worst * 100:.1f}%"
        else:
            c1 = c1w = "-"
        fps, score, play_wall = modlog_stats(f"{base}.modlog.txt")
        if fps:
            s = sorted(fps)
            p5 = s[int(len(s) * 0.05)]
            c2 = f"{sum(fps) / len(fps):.1f}/{p5:.1f}/{s[0]:.1f}"
            c2j = "○" if p5 >= hz * 0.97 else f"×(<{hz * 0.97:.1f})"
        else:
            c2 = c2j = "-"
        c3 = f"{(play_wall * hz / 60 / play - 1) * 100:+.2f}%" if play_wall else "-"
        log = open(f"{base}.log", errors="replace").read()
        res = re.findall(r"同期マーカー検証\(.*?\): 残差=([+-]?[\d.]+)ms", log)
        total = re.findall(r"総録画時間: ([\d.]+)秒", log)
        sc = "一致" if score is not None and score * 10 == args.score else f"不一致({score})"
        print(f"| {label} | {hz / 60:g}x | {c1} | {c1w} | {c2} | {c2j} | {c3} "
              f"| {res[-1] + 'ms' if res else '-'} | {sc} | {total[-1] + 's' if total else '-'} |")


if __name__ == "__main__":
    main()
