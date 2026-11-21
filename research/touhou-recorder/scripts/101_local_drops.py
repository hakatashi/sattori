#!/usr/bin/env python3
"""フェーズ101: 文字の転送がまとめて起きる時刻の前後で、落ちたフレームを数える。

Usage: python3 scripts/101_local_drops.py <bench_dir...> [--windows 66.2-69.8,196.9-201.6]
  <bench_dir>/<mode>/video.mp4 ごとに、scripts/81 の --list-bursts の結果から、指定した時間帯
  (元動画の先頭からの秒)に落ちたフレーム数と、60〜210 秒全体の落ちフレーム数を表にする。
  th13_06.rpy の 215 秒録画では、会話の開始時(約 67.7〜68.3 秒、約 198.5〜200.1 秒)に文字の転送が
  まとまって起きる(D3DX_TIMING の記録より)。録画ごとに開始のずれが 1 秒前後あるため、前後 1.5 秒の
  余裕を持たせた窓を既定にしている。
"""
import argparse, os, re, subprocess, sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BURST_RE = re.compile(r"^\s+([\d.]+)s\s+\(\S+\)\s+(\d+)フレーム脱落", re.M)


def bursts(video):
    p = subprocess.run([sys.executable, f"{REPO}/scripts/81_analyze_stutter_periodicity.py", video,
                        "--start", "60", "--duration", "150", "--list-bursts"], capture_output=True, text=True)
    return [(float(t), int(n)) for t, n in BURST_RE.findall(p.stdout + p.stderr)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dirs", nargs="+")
    ap.add_argument("--windows", default="66.2-69.8,196.9-201.6")
    a = ap.parse_args()
    wins = [tuple(map(float, w.split("-"))) for w in a.windows.split(",")]
    print("| 録画 | mode | " + " | ".join(f"{w[0]:g}〜{w[1]:g}s の落ち" for w in wins) + " | 60〜210s 全体の落ち |")
    print("|---|---|" + "---|" * len(wins) + "---|")
    for d in a.dirs:
        for mode in ("builtin", "area", "native"):
            v = os.path.join(d, mode, "video.mp4")
            if not os.path.exists(v):
                continue
            b = bursts(v)
            cells = [str(sum(n for t, n in b if w[0] <= t <= w[1])) for w in wins]
            print(f"| {os.path.basename(d.rstrip('/'))} | {mode} | " + " | ".join(cells) + f" | {sum(n for _, n in b)} |")


if __name__ == "__main__":
    main()
