#!/usr/bin/env python3
"""th06(紅魔郷)リプレイのヘッドレス録画エントリポイント(Sattori ワーカー)。

**th06 固有の設計判断と踏んだ地雷は [`docs/titles/th06.md`](docs/titles/th06.md) にある。
下の `GameConfig` を触る前に必ず読むこと。** 録画パイプライン本体は `recording/`
パッケージ、コマンドライン引数は `recording/cli.py` にあり、このファイルには
th06 でしか成り立たない値だけを置く。
"""
from recording import cli
from recording.config import GameConfig


def build_config(pulse_sink):
    return GameConfig.for_game(
        "th06", pulse_sink,
        # 同一ホストでの並列録画で映像が混ざらないよう、タイトルごとに固定する。
        display=":96",
        canonical_slot="th6_ud0000.rpy",
        # wined3dの白画面ハング回避に必須(docs/titles/th06.md)。hook_dllより前に注入する。
        extra_dlls=("vpatch_th06.dll",),
        # th07/th08と異なりリネームしない(VsyncPatchが実行ファイル名を検証しているため)。
        game_exe="東方紅魔郷.exe",
        # pgrep/pkill専用。/proc/PID/commの15バイト切り詰め対策(docs/titles/th06.md)。
        process_name="東方紅魔郷",
    )


if __name__ == "__main__":
    cli.run("th06", build_config)
