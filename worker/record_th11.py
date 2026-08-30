#!/usr/bin/env python3
"""th11(地霊殿)リプレイのヘッドレス録画エントリポイント(Sattori ワーカー)。

**th11 固有の設計判断と踏んだ地雷は [`docs/titles/th11.md`](docs/titles/th11.md) にある。
下の `GameConfig` を触る前に必ず読むこと。** 録画パイプライン本体は `recording/`
パッケージ、コマンドライン引数は `recording/cli.py` にあり、このファイルには
th11 でしか成り立たない値だけを置く。
"""
from recording import cli
from recording.config import GameConfig


def build_config(pulse_sink):
    return GameConfig.for_game(
        "th11", pulse_sink,
        # 同一ホストでの並列録画で映像が混ざらないよう、タイトルごとに固定する。
        display=":99",
        canonical_slot="th11_ud0000.rpy",
        # Pause Menu画面の選択カーソル明滅を静止判定から除外する(docs/titles/th11.md)。
        still_detect_exclude_rect=(70, 288, 188, 318),
    )


if __name__ == "__main__":
    cli.run("th11", build_config)
