#!/usr/bin/env python3
"""th15(東方紺珠伝)リプレイのヘッドレス録画エントリポイント(Sattori ワーカー)。

**th15 固有の設計判断と踏んだ地雷は [`docs/titles/th15.md`](docs/titles/th15.md) にある。
下の `GameConfig` を触る前に必ず読むこと。** 録画パイプライン本体は `recording/`
パッケージ、コマンドライン引数は `recording/cli.py` にあり、このファイルには
th15 でしか成り立たない値だけを置く。

th15はwined3d(D3D9→OpenGL)で描画するタイトルであり、Xvfb+llvmpipe(ソフトウェア
描画)でもメニュー・大半のステージは60fps付近で動作するが、Extraステージの高負荷
演出区間ではCPUコア数を増やしても解消しない処理落ちが発生する。GPU(wined3d+
OpenGL、DXVKではない)を使うことでこれが解消することを実機検証済みのため
(touhou-recorder reports/82)、th06ncと同じ`g6f`系GPUインスタンスで録画する。ただし
**DXVKは使わない**(`dxvk_dll_overrides`は指定しない。th15のVulkan実装がDXVKの要求機能を
満たさず起動できないことを実機確認済み、reports/82)。

GPUを確保できないときはCPUインスタンスの低速録画へ落ちる(Issue #316、reports/91)。起動側が
`GPU_WORKER=1`を渡さないので、Xvfb+wined3d+llvmpipeで描画する。
"""
from recording import cli
from recording.config import GameConfig
from recording.timing import gpu_worker


def build_config(pulse_sink):
    return GameConfig.for_game(
        "th15", pulse_sink,
        # 同一ホストでの並列録画で映像が混ざらないよう、タイトルごとに固定する。
        display=":104",
        canonical_slot="th15_ud0000.rpy",
        # 1280x960ウィンドウ + ウィンドウ装飾分の余白(th20と同じ内部描画解像度)。
        xvfb_screen="1400x1100x24",
        # th125以降の仕様。cfg/リプレイは%APPDATA%配下から読まれる。
        uses_appdata_profile=True,
        # GPUワーカーではGPU描画(Xorg+NVIDIA GRIDドライバ)で録る(reports/82、docs/titles/th15.md)。
        # DXVKはVulkan機能不足で起動できないため使わず、wined3d(OpenGL)のまま
        # GPU上で描画する(dxvk_dll_overridesは指定しない)。poll_side_streamを立てない
        # 既存の挙動を保つため、`with_runtime_overrides()`には任せずここで決める。
        gpu_display=gpu_worker(),
        # Xorg+nvidia環境ではウィンドウが期待の1280x960ではなくCRTCの既定モード
        # (1024x768)へ縮小される(th06ncと同じ既知の症状)ため、明示的に切り替える。
        crtc_mode="1280x960",
        # リプレイ終了後のメニュー(「再生終了/ゲームを終了/もう一度再生する」)の
        # テキスト全体を静止判定から除外する(1280x960のウィンドウ座標系、reports/82)。
        still_detect_exclude_rect=[(81, 350, 470, 800)],
    )


if __name__ == "__main__":
    cli.run("th15", build_config)
