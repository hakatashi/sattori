#!/usr/bin/env python3
"""th08(永夜抄)リプレイのヘッドレス録画エントリポイント(Sattori ワーカー)。

**th08 固有の設計判断と踏んだ地雷は [`docs/titles/th08.md`](docs/titles/th08.md) にある。
下の `GameConfig` を触る前に必ず読むこと。** 録画パイプライン本体は `recording/`
パッケージ、コマンドライン引数は `recording/cli.py` にあり、このファイルには
th08 でしか成り立たない値だけを置く。
"""
from recording import cli
from recording.config import GameConfig


def build_config(pulse_sink):
    return GameConfig.for_game(
        "th08", pulse_sink,
        # 同一ホストでの並列録画で映像が混ざらないよう、タイトルごとに固定する。
        display=":98",
        canonical_slot="th8_ud0000.rpy",
    )


if __name__ == "__main__":
    cli.run("th08", build_config)
