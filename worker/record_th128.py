#!/usr/bin/env python3
"""th128(妖精大戦争)リプレイのヘッドレス録画エントリポイント(Sattori ワーカー)。

**th128 固有の設計判断と踏んだ地雷は [`docs/titles/th128.md`](docs/titles/th128.md) にある。
下の `GameConfig` を触る前に必ず読むこと。** 録画パイプライン本体は `recording/`
パッケージ、コマンドライン引数は `recording/cli.py` にあり、このファイルには
th128 でしか成り立たない値だけを置く。
"""
from recording import cli
from recording.config import GameConfig


def build_config(pulse_sink):
    return GameConfig.for_game(
        "th128", pulse_sink,
        # 同一ホストでの並列録画で映像が混ざらないよう、タイトルごとに固定する
        # (他タイトルは:95〜:101を使用済み)。
        display=":102",
        # th11/th12/th20と同じユーザータブ方式(MODは常に1番目のユーザーリプレイを選ぶ)。
        canonical_slot="th128_ud0000.rpy",
        # th125以降の仕様。cfg/リプレイは%APPDATA%配下から読まれる(docs/titles/th128.md)。
        uses_appdata_profile=True,
        # リプレイ選択直後にゲーム本体がフリーズする既知バグの回避策として必須
        # (thprac無しだと録画が確実に失敗する、docs/titles/th128.md)。
        thprac_exe="thprac.v2.3.0.3.exe",
    )


if __name__ == "__main__":
    cli.run("th128", build_config)
