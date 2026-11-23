#!/usr/bin/env python3
"""th14(輝針城)リプレイのヘッドレス録画エントリポイント(Sattori ワーカー)。

**th14 固有の設計判断と踏んだ地雷は [`docs/titles/th14.md`](docs/titles/th14.md) にある。
下の `GameConfig` を触る前に必ず読むこと。** 録画パイプライン本体は `recording/`
パッケージ、コマンドライン引数は `recording/cli.py` にあり、このファイルには
th14 でしか成り立たない値だけを置く。

対象は ver1.00b の非Steam版(touhou-recorder reports/103)。録画の段はCPUのフレーム同期のみで、
GPUの段は持たない(GPUインスタンスでの倍速録画は未検証)。
"""
from recording import cli
from recording.config import GameConfig


def build_config(pulse_sink):
    return GameConfig.for_game(
        "th14", pulse_sink,
        # 同一ホストでの並列録画で映像が混ざらないよう、タイトルごとに固定する
        # (他タイトルは:95〜:105を使用済み)。
        display=":106",
        # th13/th15と同じユーザータブ方式(MODは常に1番目のユーザーリプレイを選ぶ)。
        canonical_slot="th14_ud0000.rpy",
        # 1280x960ウィンドウ + ウィンドウ装飾分の余白(th15・th20と同じ内部描画解像度)。
        xvfb_screen="1400x1100x24",
        # th14はcfg/リプレイを%APPDATA%/ShanghaiAlice/th14/から読む(th13・th15と同じ)。
        uses_appdata_profile=True,
        # 終了検知は画面静止検知のみ(end_template_pathは意図的に用意しない)。リプレイ
        # 終了後のメニューの明滅をこの矩形で静止判定から除外する(1280x960のウィンドウ座標系、
        # touhou-recorder reports/103)。
        still_detect_exclude_rect=[(85, 426, 85 + 295, 426 + 429)],
        # スペルプラクティスの耐久時間切れで一覧画面へ戻るリプレイ用(th13と同じ)。
        replay_list_detect=True,
        replay_list_exclude_rows=(18, 25),
    )


if __name__ == "__main__":
    cli.run("th14", build_config)
