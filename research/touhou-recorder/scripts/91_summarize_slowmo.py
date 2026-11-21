#!/usr/bin/env python3
"""CPU低速録画の結果を集計し、本番と同じ処理で配信版を作る(フェーズ91)。

scripts/91_run_slowmo_batch.sh の出力(<label>.mp4 / .log / .modlog.txt / .mpstat.txt)を読み、

  - 試行回数、終了検知方式、パイプライン判定の重複フレーム率、録画の実時間(尺に対する倍率)
  - FpsMonitor(中央値・下位5%・最低値、再生区間のみ)
  - リプレイのframeCountとの理論尺比較
  - 同期マーカー(peak比・mux後残差)
  - 配信版のカット範囲とデシンク判定(sattori `worker/recording` の関数をそのまま使う)
  - 配信版(sattori `worker/convert.py` のコマンド)の尺と落ちフレーム(scripts/81)

をMarkdownの表で出す。recorder/はカット範囲を計算しないため、録画ログの
`content_end_epoch=`と`video_start=`を渡して本番の`compute_cut_range()`を呼ぶ。

生動画の転送料金を避けるため、集計と配信版の生成は録画したインスタンス上で行い、ローカルへは
ログと主要条件の配信版だけを持ち帰る(`--replay-cache`と、転送したsattoriの`worker/`を使う)。

Usage:
  python3 scripts/91_summarize_slowmo.py --raw DIR --delivery DIR --sattori ../sattori \
    <label>:<replay.rpy>:<hz> [...]
"""
import argparse
import json
import os
import re
import statistics
import subprocess
import sys
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)


def read_last_attempt(path):
    """ログのうち最後の試行の部分と、試行回数を返す。"""
    with open(path, errors="replace") as f:
        text = f.read()
    parts = re.split(r"=== 試行 \d+/\d+ ===", text)
    return parts[-1], len(parts) - 1


def replay_info(args, replay, game):
    if args.replay_cache:
        with open(args.replay_cache) as f:
            return json.load(f)[replay]
    sattori = args.sattori
    path = f"{REPO}/games/{game}/replay/{replay}"
    out = subprocess.run(["node", f"{sattori}/packages/replay-parser/dist/cli/index.js", path, "-j"],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def fps_stats(modlog, start_sod):
    """再生開始以降のFpsMonitorの (中央値, 下位5%, 最低値, サンプル数)。"""
    vals = []
    with open(modlog, errors="replace") as f:
        for line in f:
            m = re.match(r"\[(\d+):(\d+):(\d+)\.\d+\] FpsMonitor: .*\(([\d.]+) Hz\)", line)
            if not m:
                continue
            sod = int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3])
            if start_sod is None or (sod - start_sod) % 86400 < 43200:
                vals.append(float(m[4]))
    if len(vals) < 3:
        return None
    vals = sorted(vals)
    return statistics.median(vals), vals[int(len(vals) * 0.05)], vals[0], len(vals)


def mpstat_avg(path):
    vals = []
    if not os.path.exists(path):
        return None
    with open(path, errors="replace") as f:
        for line in f:
            m = re.search(r"\s+all\s+(.*)$", line)
            if m:
                try:
                    vals.append(100.0 - float(m.group(1).split()[-1]))
                except ValueError:
                    pass
    vals = vals[20:-15] if len(vals) > 40 else vals
    return statistics.mean(vals) if vals else None


def duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of",
                          "csv=p=0", path], capture_output=True, text=True).stdout.strip()
    return float(out) if out else None


def stutter(video, dur):
    out = subprocess.run(["python3", f"{HERE}/81_analyze_stutter_periodicity.py", video,
                          "--start", "15", "--duration", str(dur)],
                         capture_output=True, text=True).stdout
    drop = re.search(r"落ちたフレーム: (\d+) \(([\d.]+)%\)", out)
    burst = re.search(r"カクつきバースト: (\d+)回", out)
    return (f"{drop[1]} ({drop[2]}%)" if drop else "-", burst[1] if burst else "-")


def summarize(args, spec, cut_mod, modlog_mod, convert):
    # 4つ目はタイトルID(リプレイ名から決まらないth06nc等、フェーズ97)
    label, replay, hz, *rest = spec.split(":")
    hz = float(hz)
    scale = 60.0 / hz
    game = rest[0] if rest else re.match(r"th\d+", replay).group(0)
    raw = f"{args.raw}/{label}"
    text, attempts = read_last_attempt(f"{raw}.log")
    info = replay_info(args, replay, game)
    game_sec = info["frameCount"] / 60.0
    modlog = f"{raw}.modlog.txt"
    cfg = SimpleNamespace(log_path=modlog, game_id=game)

    def find(pat):
        m = re.search(pat, text)
        return m.groups() if m else None

    video_start = find(r"video_start=([\d.]+)")
    end_epoch = find(r"content_end_epoch=([\d.]+)")
    total = find(r"総録画時間: ([\d.]+)秒 検知方式: (\S+)")
    dup = find(r"重複フレーム率: ([\d.]+)%")
    ok = find(r"試行(\d+)で正常な録画")
    ratio = find(r"peak_ratio=(\d+) delta=")
    residuals = re.findall(r"同期マーカー検証\(.*\): 残差=([+-][\d.]+)ms", text)

    ref_epoch = float(video_start[0]) if video_start else None
    start_epoch = modlog_mod.find_replay_start_epoch(modlog, reference_epoch=ref_epoch)
    start_sod = None
    if start_epoch is not None:
        # MODログの行頭時刻はインスタンスのローカル時刻(UTC)
        start_sod = int(start_epoch) % 86400
    fps = fps_stats(modlog, start_sod)

    excess = None
    if start_epoch is not None and end_epoch:
        played = (float(end_epoch[0]) - start_epoch) / scale
        excess = (played - game_sec) / game_sec * 100.0

    # 本番のカット計算へ渡す。映像の中間ファイルは転送しないので、開始時刻だけログから与える。
    cut = {"startSec": None, "endSec": None}
    if video_start:
        cut_mod.ffprobe_start_time = lambda _p, _e: float(video_start[0])
        cut = cut_mod.compute_cut_range(
            cfg, "unused", f"{raw}.mp4", os.environ.copy(), time_scale=scale,
            content_end_epoch=float(end_epoch[0]) if end_epoch else None,
            reference_epoch=ref_epoch, log=lambda s: print(f"  [{label}] {s}", file=sys.stderr))
    desync = modlog_mod.check_replay_desync(cfg, info.get("score"), log=lambda s: None)

    out_path = f"{args.delivery}/{label}_delivery.mp4"
    if not os.path.exists(out_path) and os.path.exists(f"{raw}.mp4"):
        os.makedirs(args.delivery, exist_ok=True)
        w, h = convert.probe_resolution(f"{raw}.mp4")
        sr = convert.probe_audio_sample_rate(f"{raw}.mp4") if scale != 1.0 else None
        # 本番の配信版と同じコマンド(ウォーターマークのみ省略)
        cmd = convert.build_convert_cmd(
            f"{raw}.mp4", out_path, width=w, height=h, time_scale=scale, audio_sample_rate=sr,
            cut_start=cut["startSec"], cut_end=cut["endSec"])
        subprocess.run(cmd, check=True, capture_output=True)
    dur = duration(out_path) if os.path.exists(out_path) else None
    drops = stutter(out_path, max(1.0, dur - 15)) if dur else ("-", "-")
    cpu = mpstat_avg(f"{raw}.mpstat.txt")

    wall = float(total[0]) if total else None
    fps_txt = f"{fps[0]:.1f}/{fps[1]:.1f}/{fps[2]:.1f}" if fps else "-"
    return {
        "label": label, "hz": hz,
        "row": [
            label, f"{ok[0] if ok else '失敗'}/{attempts}", total[1] if total else "-",
            f"{dup[0]}%" if dup else "-", fps_txt,
            f"{excess:+.2f}%" if excess is not None else "-",
            f"{ratio[0] if ratio else '-'}/{residuals[-1] + 'ms' if residuals else '-'}",
            f"{cut['startSec']:.1f}〜{cut['endSec']:.1f}" if cut["startSec"] and cut["endSec"]
            else f"{cut['startSec']}〜{cut['endSec']}",
            {True: "不一致", False: "一致", None: "判定不能"}[desync],
            f"{dur:.1f}s/{game_sec:.1f}s" if dur else "-", drops[0], drops[1],
            f"{cpu:.1f}" if cpu is not None else "-",
            f"{wall:.0f}s (×{wall / game_sec:.2f})" if wall else "-",
        ],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True)
    ap.add_argument("--delivery", required=True)
    ap.add_argument("--sattori", default=f"{REPO}/../..")
    ap.add_argument("--replay-cache", default=None,
                    help="リプレイ名→replay-parserの出力のJSON。nodeの無いインスタンス上で集計するときに使う")
    ap.add_argument("specs", nargs="+", help="<label>:<replay.rpy>:<hz>[:<game>]")
    args = ap.parse_args()

    sys.path.insert(0, f"{args.sattori}/worker")
    import convert
    from recording import cut as cut_mod
    from recording import modlog as modlog_mod

    print("| label | 採用試行/全試行 | 終了検知 | 判定重複率 | fps中央/下位5%/最低 | 理論尺比 | マーカー比/残差 "
          "| カット範囲(録画時間軸) | スコア | 配信版尺/ゲーム尺 | 落ち | バースト | CPU% | 録画実時間(倍率) |")
    print("|" + "---|" * 14)
    for spec in args.specs:
        print("| " + " | ".join(summarize(args, spec, cut_mod, modlog_mod, convert)["row"]) + " |",
              flush=True)


if __name__ == "__main__":
    main()
