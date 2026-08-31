#!/usr/bin/env python3
"""th12(星蓮船)リプレイのヘッドレス録画エントリポイント(Sattori ワーカー)。

**th12 固有の設計判断と踏んだ地雷は [`docs/titles/th12.md`](docs/titles/th12.md) にある。
下の `GameConfig` を触る前に必ず読むこと。** 録画パイプライン本体は `recording/`
パッケージ、コマンドライン引数は `recording/cli.py` にあり、このファイルには
th12 でしか成り立たない値だけを置く。
"""
from recording import cli
from recording.config import GameConfig


def build_config(pulse_sink):
    return GameConfig.for_game(
        "th12", pulse_sink,
        # 同一ホストでの並列録画で映像が混ざらないよう、タイトルごとに固定する
        # (他タイトルは:95〜:99を使用済み)。
        display=":100",
        # th11と同じユーザータブ方式(MODは常に1番目のユーザーリプレイを選ぶ)。
        canonical_slot="th12_ud0000.rpy",
        # VsyncPatchを常時有効化する(ユーザー指示)。th10のBugFixTh10Power3のような
        # ini切替オプションは無く、常に有効な状態で録画する固定仕様
        # (docs/titles/th12.md)。
        extra_dlls=("vpatch_th12.dll",),
        # th11と同じく画面静止検知のみで終了判定する(end_template_pathは意図的に
        # 用意しない)。Pause Menu画面の明滅対策としてこの矩形を静止判定から除外する。
        still_detect_exclude_rect=(48, 214, 203, 430),
        # ゲームウィンドウが最小化(Iconic)状態で作成される既知の不具合対策
        # (docs/titles/th12.md、touhou-recorder reports/61)。
        force_window_map=True,
    )


if __name__ == "__main__":
    cli.run("th12", build_config)
