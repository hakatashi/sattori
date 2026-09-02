#!/usr/bin/env python3
"""th09(花映塚)リプレイのヘッドレス録画エントリポイント(Sattori ワーカー)。

**th09 固有の設計判断と踏んだ地雷は [`docs/titles/th09.md`](docs/titles/th09.md) にある。
下の `GameConfig` を触る前に必ず読むこと。** 録画パイプライン本体は `recording/`
パッケージ、コマンドライン引数は `recording/cli.py` にあり、このファイルには
th09 でしか成り立たない値だけを置く。
"""
from recording import cli
from recording.config import GameConfig


def build_config(pulse_sink):
    return GameConfig.for_game(
        "th09", pulse_sink,
        display=":101",
        # 実行ファイル名はth09.exeだが、リプレイファイル名の接頭辞は"th9_"
        # (th09ではなくth9)。誤って"th09_ud0000.rpy"を配置するとゲーム側が
        # 認識せずリプレイ一覧が空のまま(実機検証で発覚)。
        canonical_slot="th9_ud0000.rpy",
        # リプレイ選択画面の見出し「映花一覧」部分のみに絞り込む(0000スロットの
        # 内容(スコア・日付)を含めると誤判定するため、th10と同様の対応)。
        end_template_rect=(0, 0, 230, 88),
    )


if __name__ == "__main__":
    cli.run("th09", build_config)
