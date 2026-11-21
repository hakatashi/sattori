#!/usr/bin/env python3
"""指定コア数ぶんのCPU負荷を発生させる検証用ツール(フェーズ109)。

同居プロセスの高負荷下でフレーム同期キャプチャが決定的に動作するかを検証するため、
指定ワーカー数だけプロセスをforkして浮動小数演算ループでCPUを飽和させる。
SIGTERM/SIGINTで子プロセスを確実に終了させる。

使い方:
  python3 scripts/109_cpu_load.py --workers 16
"""
import argparse
import multiprocessing
import signal
import sys


def _burn():
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    x = 1.0000001
    while True:
        for _ in range(100000):
            x = (x * 1.0000001 + 0.0000003) % 1000.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, required=True)
    args = ap.parse_args()

    procs = []

    def stop(*_):
        for p in procs:
            if p.is_alive():
                p.terminate()
        for p in procs:
            p.join(timeout=2)
        sys.exit(0)

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    for _ in range(args.workers):
        p = multiprocessing.Process(target=_burn)
        p.start()
        procs.append(p)
    print(f"CPU load started: workers={args.workers}", flush=True)
    for p in procs:
        p.join()


if __name__ == "__main__":
    main()
