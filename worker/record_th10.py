#!/usr/bin/env python3
"""th10(風神録)リプレイのヘッドレス録画エントリポイント(Sattori ワーカー)。

**th10 固有の設計判断と踏んだ地雷は [`docs/titles/th10.md`](docs/titles/th10.md) にある。
下の `GameConfig` を触る前に必ず読むこと。** 録画パイプライン本体は `recording/`
パッケージ、コマンドライン引数は `recording/cli.py` にあり、このファイルには
th10 でしか成り立たない値だけを置く。
"""
import os

from recording import cli
from recording.config import GameConfig


def build_config(pulse_sink):
    # 魔理沙Bのバグマリ修正(Issue #75)。apps/api/src/workerEnv.tsが
    # `RecordingOptions.th10BugfixMarisaB`(既定false)に応じて渡す。記録時の設定と
    # 一致させないとデシンクするため、未指定時も明示的に"0"(パッチ無効)へ揃える
    # (同梱アセットのvpatch.iniの既定値に依存しないようにするため、docs/titles/th10.md)。
    bugfix_marisa_b = os.environ.get("TH10_BUGFIX_MARISA_B") == "1"
    return GameConfig.for_game(
        "th10", pulse_sink,
        # 同一ホストでの並列録画で映像が混ざらないよう、タイトルごとに固定する。
        display=":98",
        # th06/07/08と同じ番号スロット方式(`_ud0000`のタブ切替方式ではない)。
        canonical_slot="th10_01.rpy",
        extra_dlls=("vpatch_th10.dll",),
        # 背景が常時アニメーションするため、内容非依存の"REPLAY"見出しだけで照合する
        # (docs/titles/th10.md・decisions/0037)。
        end_template_rect=(0, 0, 244, 76),
        end_template_mad_threshold=25.0,
        vpatch_ini_overrides=(("Option", "BugFixTh10Power3", "1" if bugfix_marisa_b else "0"),),
    )


if __name__ == "__main__":
    cli.run("th10", build_config)
