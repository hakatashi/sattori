#!/usr/bin/env python3
"""th06ncのg6f.xlarge録画の結果をMarkdownの表にする(フェーズ94)。

scripts/94_run_worker_batch.sh の出力(<logs>/<label>/ 配下)を読む。配信版は倍速でも`-r 60`変換(94_worker_run.py)。
プロセス別CPUはpidstatのスレッド行(TID列が数字)をコマンド別に合計し、録画中(3件目以降)の平均を%で出す(4vCPUで最大400)。

Usage:
  python3 scripts/94_summarize.py <logsディレクトリ> <label>:<リプレイの尺(秒)> [...]
"""
import collections
import importlib.util
import json
import os
import re
import statistics
import sys

spec = importlib.util.spec_from_file_location("s92", os.path.join(os.path.dirname(os.path.abspath(__file__)), "92_summarize.py"))
s92 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s92)
read, one, stutter, fps_monitor, cpu_avg = s92.read, s92.one, s92.stutter, s92.fps_monitor, s92.cpu_avg


def enc_avg(text):
    # vGPUでは sm が "-" になることがある。enc列のみ取れた値で平均する
    vals = []
    for line in text.splitlines():
        cols = line.split()
        if len(cols) >= 7 and cols[0] == "0" and cols[6].isdigit() and int(cols[6]) > 0:
            vals.append(int(cols[6]))
    return f"{statistics.mean(vals):.0f}" if vals else "-"


def per_command(text):
    """{コマンド: 平均%CPU}。録画の山のみにするため、ffmpegのスレッドが見えるサンプルだけ数える。"""
    samples = collections.defaultdict(lambda: collections.Counter())
    for line in text.splitlines():
        c = line.split()
        if len(c) < 11 or not c[3].isdigit():  # スレッド行のみ(TGID行はTIDが"-")
            continue
        name = re.sub(r"^\|__", "", c[10])
        samples[c[0]][name] += float(c[8])
    rec = [v for v in samples.values() if any(k.startswith("ffmpeg") or k.startswith("ffmpeg") for k in v)]
    rec = rec[2:-2] if len(rec) > 8 else rec
    if not rec:
        return {}
    keys = {k for v in rec for k in v}
    return {k: sum(v[k] for v in rec) / len(rec) for k in keys}


def top_threads(text, n=6):
    pc = per_command(text)
    return " ".join(f"{k}={v:.0f}" for k, v in sorted(pc.items(), key=lambda x: -x[1])[:n])


def main():
    logs = sys.argv[1]
    print("| 条件 | 試行 | スコア | 重複率 | 同期残差 | FpsMonitor 中央/下位5%/最低(Hz) | CPU% | enc% "
          "| 配信版の実効fps(落ち) | 録画(倍率) | 変換 | 計(倍率) | 主なスレッド%CPU |")
    print("|" + "---|" * 13)
    for spec_ in sys.argv[2:]:
        label, dur = spec_.split(":")
        dur = float(dur)
        d = f"{logs}/{label}"
        run = read(f"{d}/run.log")
        attempt = one(r"試行(\d+)で正常な録画", run)
        desync = json.loads(read(f"{d}/desync_result.json") or "{}").get("desyncDetected")
        dup = one(r"重複フレーム率: ([\d.]+)%", run)
        res = one(r"同期マーカー検証\(.*\): 残差=([+-][\d.]+)ms", run)
        t = json.loads(read(f"{d}/timing.json") or "{}")
        rec = t.get("record_done", 0) - t.get("assets_done", 0)
        conv = t.get("convert_done", 0) - t.get("record_done", 0)
        print(f"| {label} | {attempt or '失敗'} | {'一致' if desync is False else desync} | {dup}% | {res}ms "
              f"| {fps_monitor(read(f'{d}/th06nc_autoplay.log'))} | {cpu_avg(read(f'{d}/cpu.txt'))} "
              f"| {enc_avg(read(f'{d}/gpu.txt'))} | {stutter(f'{d}/stutter.txt')} "
              f"| {rec:.0f}s (×{rec / dur:.2f}) | {conv:.0f}s | {rec + conv:.0f}s (×{(rec + conv) / dur:.2f}) "
              f"| {top_threads(read(f'{d}/pidstat.txt'))} |")


if __name__ == "__main__":
    main()
