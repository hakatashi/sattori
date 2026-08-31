#!/usr/bin/env python3
"""th20(錦上京)リプレイのヘッドレス録画エントリポイント(Sattori ワーカー)。

**th20 固有の設計判断と踏んだ地雷は [`docs/titles/th20.md`](docs/titles/th20.md) にある。
下の `GameConfig` を触る前に必ず読むこと。** 録画パイプライン本体は `recording/`
パッケージ、コマンドライン引数は `recording/cli.py` にあり、このファイルには
th20 でしか成り立たない値だけを置く。
"""
from recording import cli
from recording.config import GameConfig


def build_config(pulse_sink):
    return GameConfig.for_game(
        "th20", pulse_sink,
        # 同一ホストでの並列録画で映像が混ざらないよう、タイトルごとに固定する。
        display=":95",
        canonical_slot="th20_ud0000.rpy",
        # 1280x960ウィンドウ + ウィンドウ装飾分の余白(docs/titles/th20.md)。
        xvfb_screen="1400x1100x24",
        # th125以降の仕様。cfg/リプレイは%APPDATA%配下から読まれる。
        uses_appdata_profile=True,
        # リプレイ終了後もアニメーションが継続する2箇所を静止判定から除外する
        # (1280x960のウィンドウ座標系)。
        still_detect_exclude_rect=[
            (68, 245, 68 + 406, 245 + 604),
            (851, 488, 851 + 420, 488 + 420),
        ],
        # デシンク対策。ゲーム起動直後にアタッチする(`recording.process.attach_thprac()`)。
        # games/th20/ に同梱しておくこと。
        thprac_exe="thprac.v2.3.0.3.exe",
    )


if __name__ == "__main__":
    cli.run("th20", build_config)
