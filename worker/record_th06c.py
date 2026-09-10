#!/usr/bin/env python3
"""th06c(東方紅魔郷: Classic)リプレイのヘッドレス録画エントリポイント(Sattori ワーカー)。

**th06c 固有の設計判断と踏んだ地雷は [`docs/titles/th06c.md`](docs/titles/th06c.md) にある。
下の `GameConfig` を触る前に必ず読むこと。** 録画パイプライン本体は `recording/`
パッケージ、コマンドライン引数は `recording/cli.py` にあり、このファイルには
th06c でしか成り立たない値だけを置く。
"""
import os

from recording import cli
from recording.config import WORKER_ROOT, GameConfig


def build_config(pulse_sink):
    # for_game()内のmod_dir解決(SATTORI_MOD_DIR対応)と同じロジックをここでも踏む必要が
    # ある。injector_pathの上書き自体がoverrides経由でfor_game()の外から行われるため
    # (docs/titles/th06c.md)、決め打ちでWORKER_ROOTを使うとローカル検証時に
    # SATTORI_MOD_DIRを渡しても無視されてしまう。
    mod_dir = os.environ.get("SATTORI_MOD_DIR", f"{WORKER_ROOT}/mods")
    return GameConfig.for_game(
        "th06c", pulse_sink,
        # 同一ホストでの並列録画で映像が混ざらないよう、タイトルごとに固定する。
        display=":102",
        # th06cはリプレイ一覧をファイル名ではなく`./replay`ディレクトリの列挙順
        # (FindFirstFileA/FindNextFileA)で決め、MODは常に1番目を選ぶ固定シーケンス
        # のため、ファイル名自体は任意でよい(docs/titles/th06c.md)。
        canonical_slot="th6_01.rpy",
        # th06c.exeはPE32+(x86-64)のため、他タイトル共通の32bit injector.exeではなく
        # 64bit版を使う(docs/titles/th06c.md)。build-mods skillが
        # mods/common/build/injector64.exeとしてビルドする。
        injector="injector64.exe",
        injector_path=f"{mod_dir}/common/build/injector64.exe",
        # 起動のたびに解像度選択ダイアログが出るため、ウィンドウ検出前に
        # 640x480x24より広い画面が要る(openboxの初期配置のままでは収まらず、
        # ウィンドウ移動でタイトルバーが写り込む問題を避けるため)。
        xvfb_screen="1400x1100x24",
        # リプレイ選択画面(見出し帯のみ)との照合。一覧行はリプレイ本数に応じて
        # 伸びるため、内容非依存の見出し部分だけに絞り込む(docs/titles/th06c.md)。
        end_template_rect=(20, 78, 560, 152),
    )


if __name__ == "__main__":
    cli.run("th06c", build_config)
