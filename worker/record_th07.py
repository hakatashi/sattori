#!/usr/bin/env python3
"""th07(妖々夢)リプレイのヘッドレス録画エントリポイント(Sattori ワーカー)。

**th07 固有の設計判断と踏んだ地雷は [`docs/titles/th07.md`](docs/titles/th07.md) にある。
下の `GameConfig` を触る前に必ず読むこと。** 録画パイプライン本体は `recording/`
パッケージ、コマンドライン引数は `recording/cli.py` にあり、このファイルには
th07 でしか成り立たない値だけを置く。
"""
from recording import cli
from recording.config import GameConfig


def build_config(pulse_sink):
    return GameConfig.for_game(
        "th07", pulse_sink,
        # 同一ホストでの並列録画で映像が混ざらないよう、タイトルごとに固定する。
        display=":97",
        # th07 のリプレイ一覧で 1 件目に並ぶ正規スロット名。MOD は「1 件目のリプレイを
        # 固定選択」するため、アップロードされた任意ファイル名をこの名前で配置することで
        # 任意のリプレイを再生できる(MOD 自体の改修は不要)。
        canonical_slot="th7_ud0000.rpy",
        # 桜点表示バグ修正(BugFixCherry)のためVsyncPatchを導入。hook_dllより前に注入する。
        extra_dlls=("vpatch_th07.dll",),
    )


if __name__ == "__main__":
    cli.run("th07", build_config)
