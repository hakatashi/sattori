#!/usr/bin/env python3
"""th13(神霊廟)リプレイのヘッドレス録画エントリポイント(Sattori ワーカー)。

**th13 固有の設計判断と踏んだ地雷は [`docs/titles/th13.md`](docs/titles/th13.md) にある。
下の `GameConfig` を触る前に必ず読むこと。** 録画パイプライン本体は `recording/`
パッケージ、コマンドライン引数は `recording/cli.py` にあり、このファイルには
th13 でしか成り立たない値だけを置く。

対象は ver1.00c の非Steam版(touhou-recorder reports/100)。Steam版はDRMで起動できない。
"""
from recording import cli
from recording.config import GameConfig


def build_config(pulse_sink):
    return GameConfig.for_game(
        "th13", pulse_sink,
        # 同一ホストでの並列録画で映像が混ざらないよう、タイトルごとに固定する
        # (他タイトルは:95〜:104を使用済み)。
        display=":105",
        # th11/th12と同じユーザータブ方式(MODは常に1番目のユーザーリプレイを選ぶ)。
        canonical_slot="th13_ud0000.rpy",
        # th13はcfg/リプレイを%APPDATA%/ShanghaiAlice/th13/から読む(th128・th20と同じ)。
        uses_appdata_profile=True,
        # 終了検知は画面静止検知のみ(end_template_pathは意図的に用意しない)。リプレイ
        # 終了後のメニューの明滅をこの矩形で静止判定から除外する(reports/100)。
        still_detect_exclude_rect=(48, 220, 48 + 159, 220 + 212),
        # 低速録画ではPresentの上限に加えてQPC偽装でも減速する。ゲームのフレーム待ちと
        # 画面右下のfps表示がQPC基準なので、揃えて減速すると表示が「60.0fps」のままになる
        # (reports/100の1/2倍速はこの構成で検証した)。
        slow_motion_speed_hack=True,
    )


if __name__ == "__main__":
    cli.run("th13", build_config)
