#!/usr/bin/env python3
"""th10(風神録)リプレイのヘッドレス録画パイプライン(Sattori ワーカー)。

touhou-recorder での事前検証(reports/56〜60)を踏まえた実装:

- th10.exeはth11/th20と異なり、TH10エンジン初出のこのタイトルではまだ
  GetKeyboardState方式に切り替わっておらず、DirectInputのGetDeviceStateが実際に
  56〜60Hzでポーリングされる(FpsMonitorログで確認)。そのためth06/07/08と同じ
  PressKey(DIKスキャンコード経由)を使う(`mods/th10_replay_autoplay/dllmain.cpp`)。
- タイトル画面に明示的な"PRESS ANY BUTTON"表示があり、Enterで消す必要がある
  (th08等には無いステップ)。この"タイトル消し"のEnterを送るタイミングが早すぎると
  (タイトルロゴ演出中は入力がバッファされず単純に無視される)、後続のDown/Enterが
  ずれてGame Start経由の別ルートに迷い込む。6000ms待つことで安定して機能する。
- リプレイ一覧はth06/07/08と同じ単純な番号スロット方式(ファイル名の数字がそのまま
  スロット番号No.NNに対応、th11/th20の`_ud0000`タブ切替方式ではない)。MODは常に
  1番目のスロットを選ぶ固定シーケンスのため、`canonical_slot="th10_01.rpy"`に
  正規化する。
- VsyncPatch(`vpatch_th10.dll`、th06と同じ`extra_dlls`の仕組みで注入)を導入した
  状態で録画する。既知バグ「バグマリ」(魔理沙Bのパワーが3.00〜3.95の間にあるとき
  ショット火力が異常上昇する)を修正する`vpatch.ini`の`BugFixTh10Power3`設定は、
  **記録リプレイと再生時で必ず一致させないとリプレイずれ(デシンク)が起きる**
  (4パターン全て実機確認済み、reports/58)。リプレイファイル自体にはこの設定情報が
  含まれないため、ページAの詳細設定オプション(`RecordingOptions.th10BugfixMarisaB`、
  既定false)で利用者に申告してもらい、`TH10_BUGFIX_MARISA_B`環境変数経由で
  `vpatch.ini`を録画直前に書き換える(`recording_common.apply_vpatch_ini_overrides()`)。
- リプレイ選択画面は背景全体が常時アニメーションしており画面静止検知が使えないため、
  終了検知はテンプレート照合方式を使う。ただし上部帯全体(th06/07/08の既定領域)を
  比較すると背景アニメーションに引きずられてMADが上振れするため、リプレイ内容に
  依存しない左上の"REPLAY"見出し部分(0,0,244,76)だけに絞り込み、閾値も専用の値
  (25.0)を使う(`end_template_rect`/`end_template_mad_threshold`、reports/56)。
- 日本語ロケール必須・fps暴走の検知・処理落ちの早期検知・自動リトライ・音声/映像の
  別プロセス録画は他タイトルと共通の実装(`recording_common.py`)をそのまま使う。
"""
import argparse
import os

import pulse
from recording_common import GameConfig, log_with_prefix, record_with_retry

REPO = os.path.dirname(os.path.abspath(__file__))


def log(msg):
    log_with_prefix("record_th10", msg)


def build_config(pulse_sink):
    instance_dir = os.environ.get("SATTORI_INSTANCE_DIR", f"{REPO}/instances/th10-recording")
    game_dir_src = os.environ.get("SATTORI_GAME_DIR", f"{REPO}/games/th10")
    mod_dir = os.environ.get("SATTORI_MOD_DIR", f"{REPO}/mods")
    # 魔理沙Bのバグマリ修正(Issue #75)。apps/api/src/workerEnv.tsが
    # `RecordingOptions.th10BugfixMarisaB`(既定false)に応じて渡す。記録時の設定と
    # 一致させないとデシンクするため、未指定時も明示的に"0"(パッチ無効)へ揃える
    # (同梱アセットのvpatch.iniの既定値に依存しないようにするため、reports/58)。
    bugfix_marisa_b = os.environ.get("TH10_BUGFIX_MARISA_B") == "1"
    return GameConfig(
        game_id="th10",
        pulse_sink=pulse_sink,
        display=os.environ.get("SATTORI_DISPLAY", ":98"),
        wineprefix=os.environ.get("WINEPREFIX", f"{REPO}/prefixes/th10-wined3d-gl"),
        instance_dir=instance_dir,
        game_dir_src=game_dir_src,
        canonical_slot="th10_01.rpy",
        injector_path=f"{mod_dir}/common/build/injector.exe",
        hook_dll_path=f"{mod_dir}/th10_replay_autoplay/build/th10_hook.dll",
        extra_dlls=("vpatch_th10.dll",),
        end_template_rect=(0, 0, 244, 76),
        end_template_mad_threshold=25.0,
        vpatch_ini_overrides=(("Option", "BugFixTh10Power3", "1" if bugfix_marisa_b else "0"),),
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--replay-path", required=True, help="録画対象リプレイの絶対パス(任意ファイル名)")
    parser.add_argument("--output", required=True, help="出力する mp4 のパス")
    parser.add_argument(
        "--progress-dir", default=None,
        help="進捗スクリーンショット(frame.jpg)/状態(state.json)の書き出し先。未指定なら無効(ローカル単体実行との後方互換)",
    )
    parser.add_argument(
        "--expected-duration-seconds", type=float, default=None,
        help="リプレイの推定再生時間(進捗率算出用の参考値、未指定なら進捗率は算出しない)",
    )
    parser.add_argument(
        "--expected-score", type=int, default=None,
        help="リプレイファイルに記録された最終スコア(画面表示値)。リプレイずれの事後検証"
             "(Issue #103)に使う。未指定なら検証をスキップする",
    )
    parser.add_argument(
        "--desync-result-path", default=None,
        help="リプレイずれ検証の結果(JSON)の書き出し先。未指定なら書き出さない",
    )
    parser.add_argument(
        "--timeout-result-path", default=None,
        help="タイムアウト打ち切り検知結果(JSON、Issue #161)の書き出し先。未指定なら書き出さない",
    )
    parser.add_argument(
        "--pulse-sink", default=None,
        help="このジョブ専用のPulseAudio null-sink名(録画開始時に作成し終了時に破棄する、Issue #48)。"
             "未指定ならプロセスIDから採番する(ローカル単体実行向け)",
    )
    parser.add_argument("--max-attempts", type=int, default=3, help="異常検知時の最大試行回数")
    parser.add_argument(
        "--max-duplicate-rate", type=float, default=30.0,
        help="録画開始15秒以降の重複フレーム率(%%)がこれを超えたら処理落ちとみなし自動リトライする",
    )
    args = parser.parse_args()

    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    if args.progress_dir:
        os.makedirs(args.progress_dir, exist_ok=True)

    config = build_config(args.pulse_sink or pulse.local_sink_name())
    success = record_with_retry(
        config, args.replay_path, args.output,
        progress_dir=args.progress_dir, expected_duration_seconds=args.expected_duration_seconds,
        max_attempts=args.max_attempts, max_duplicate_rate=args.max_duplicate_rate,
        expected_score=args.expected_score, desync_result_path=args.desync_result_path,
        timeout_result_path=args.timeout_result_path,
        log=log,
    )
    if not success:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
