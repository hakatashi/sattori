#!/usr/bin/env python3
"""倍速録画の結果を1行ずつ集計する(フェーズ89)。

scripts/89_run_speedup_batch.sh の出力(<label>.log / .modlog.txt / .mpstat.txt / .gpu.txt)と、
scripts/47_descale_th20_slowmo.py で等倍へ戻した動画を読み、

  試行回数 / 最終判定の重複フレーム率 / FpsMonitor(中央値・下位5%・倍率換算の比) /
  スコア(ScoreMonitorの最終値) / 同期マーカー(peak比・start_time方式との差・mux後残差) /
  CPU平均・GPU(sm/enc)平均 / 復元後の落ちフレーム(scripts/81、15秒〜) /
  録画の実時間

をMarkdownの表の行として出す。

Usage:
  python3 scripts/89_summarize_speedup.py --raw DIR --restored DIR label [label ...]
  (labelは "th07_3x" のように末尾が "<N>x")
"""
import argparse
import os
import re
import statistics
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))


def grep(path, pat):
    if not os.path.exists(path):
        return []
    with open(path, errors="replace") as f:
        return [m for line in f for m in [re.search(pat, line)] if m]


def mpstat_avg(path):
    vals = []
    for m in grep(path, r"\s+all\s+(.*)$"):
        cols = m.group(1).split()
        try:
            vals.append(100.0 - float(cols[-1]))
        except ValueError:
            pass
    # 録画開始・終了の前後を落とす
    vals = vals[20:-15] if len(vals) > 40 else vals
    return statistics.mean(vals) if vals else None


def gpu_avg(path):
    sm, enc = [], []
    for m in grep(path, r"^\s+0\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)"):
        sm.append(int(m.group(1)))
        enc.append(int(m.group(3)))
    if not sm:
        return None
    return statistics.mean(sm), statistics.mean(enc)


def stutter(restored, duration):
    out = subprocess.run(["python3", f"{HERE}/81_analyze_stutter_periodicity.py", restored,
                          "--start", "15", "--duration", str(duration)],
                         capture_output=True, text=True).stdout
    drop = re.search(r"落ちたフレーム: (\d+) \(([\d.]+)%\)", out)
    burst = re.search(r"カクつきバースト: (\d+)回", out)
    per = re.search(r"最も当てはまる周期: ([\d.]+)秒 \(位相集中度 R=([\d.]+)\)", out)
    return (drop.group(1) + f" ({drop.group(2)}%)" if drop else "-",
            burst.group(1) if burst else "-",
            f"{per.group(1)}s/R={per.group(2)}" if per else "-")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True)
    ap.add_argument("--restored", required=True)
    ap.add_argument("labels", nargs="+")
    args = ap.parse_args()
    print("| label | 試行 | 重複率 | fps中央/下位5%(目標比) | 最大スコア | マーカー比/方式差/残差 "
          "| CPU% | GPU sm/enc | 復元後の落ち | バースト | 周期 | 録画実時間 |")
    print("|" + "---|" * 12)
    for label in args.labels:
        log = f"{args.raw}/{label}.log"
        mult = float(re.search(r"_([\d.]+)x", label).group(1))
        tries = grep(log, r"試行(\d+)で正常な録画")
        dup = grep(log, r"重複フレーム率: ([\d.]+)%")
        fps = sorted(float(m.group(1)) for m in grep(f"{args.raw}/{label}.modlog.txt",
                                                        r"FpsMonitor: .*\(([\d.]+) Hz\)"))
        fps = fps[2:] if len(fps) > 6 else fps  # 起動直後を粗く除外
        med = statistics.median(fps) if fps else None
        p5 = fps[int(len(fps) * 0.05)] if fps else None
        score = grep(f"{args.raw}/{label}.modlog.txt", r"ScoreMonitor: score=(\d+)")
        mk = grep(log, r"peak_ratio=(\d+) delta=([+-][\d.]+)s \(start_time方式との差 ([+-][\d.]+)s\)")
        res = grep(log, r"同期マーカー検証\(.*\): 残差=([+-][\d.]+)ms")
        total = grep(log, r"総録画時間: ([\d.]+)秒")
        cpu = mpstat_avg(f"{args.raw}/{label}.mpstat.txt")
        g = gpu_avg(f"{args.raw}/{label}.gpu.txt")
        restored = f"{args.restored}/{label}_restored.mp4"
        dur = None
        if os.path.exists(restored):
            d = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                "-of", "csv=p=0", restored], capture_output=True, text=True).stdout
            # 末尾はリプレイ終了後の静止画面(終了検知待ち)なので除外する
            dur = float(d) - 15 - 45 if d.strip() else None
        st = stutter(restored, dur) if dur and dur > 0 else ("-", "-", "-")
        print(f"| {label} | {tries[-1].group(1) if tries else '失敗'} "
              f"| {dup[-1].group(1) + '%' if dup else '-'} "
              f"| {med or 0:.1f}/{p5 or 0:.1f} ({(med or 0) / (60 * mult):.3f}) "
              # 最大値(th07/th08はリプレイ終了直後にポインタ先のゴミ値が出るため最終値ではなく
              # 最大値の方が記録スコアに一致しやすい。ただしゴミ値が最大になる場合もあるので
              # 最終判定は目視・replay-parserの記録と突き合わせること)
              f"| {max(int(m.group(1)) for m in score) if score else '-'} "
              f"| {mk[-1].group(1) + '/' + mk[-1].group(3) + 's' if mk else '-'}"
              f"/{res[-1].group(1) + 'ms' if res else '-'} "
              f"| {f'{cpu:.1f}' if cpu is not None else '-'} "
              f"| {f'{g[0]:.0f}/{g[1]:.0f}' if g else '-'} "
              f"| {st[0]} | {st[1]} | {st[2]} | {total[-1].group(1) + 's' if total else '-'} |")


if __name__ == "__main__":
    main()
