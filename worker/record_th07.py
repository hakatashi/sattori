#!/usr/bin/env python3
"""th07(妖々夢)リプレイのヘッドレス録画パイプライン(Sattori ワーカー)。

touhou-recorder の PoC スクリプト
(scripts/11_record_th07_replay_e2e.py, reports/11・13・14) を Web サービス向けに
刷新したもの。PoC からの主な変更点は「録画対象リプレイを固定ファイル名ではなく
任意パスから受け取り、ゲームが認識する正規スロット名で配置する」点。

録画本体の処理(Xvfb起動・ウィンドウ検出・終了検知・処理落ち早期検知・自動リトライ等)
は th08 と共通のため `recording_common.py` に集約されている(Issue #13 対応時に
th08向けの検知・リトライ機構を両タイトル共通化した)。本ファイルはタイトル固有の
パス設定(`GameConfig`)を組み立てて渡すだけの薄いラッパー。
"""
import argparse
import os

from recording_common import GameConfig, log_with_prefix, record_with_retry

REPO = os.path.dirname(os.path.abspath(__file__))


def log(msg):
    log_with_prefix("record_th07", msg)


def build_config():
    instance_dir = os.environ.get("SATTORI_INSTANCE_DIR", f"{REPO}/instances/th07-recording")
    game_dir_src = os.environ.get("SATTORI_GAME_DIR", f"{REPO}/games/th07")
    mod_dir = os.environ.get("SATTORI_MOD_DIR", f"{REPO}/mods")
    return GameConfig(
        game_id="th07",
        display=os.environ.get("SATTORI_DISPLAY", ":97"),
        wineprefix=os.environ.get("WINEPREFIX", f"{REPO}/prefixes/th07-wined3d-gl"),
        instance_dir=instance_dir,
        game_dir_src=game_dir_src,
        # th07 のリプレイ一覧で 1 件目に並ぶ正規スロット名。MOD は「1 件目のリプレイを
        # 固定選択」するため、アップロードされた任意ファイル名をこの名前で配置することで
        # 任意のリプレイを再生できる(MOD 自体の改修は不要)。
        canonical_slot="th7_ud0000.rpy",
        injector_path=f"{mod_dir}/common/build/injector.exe",
        hook_dll_path=f"{mod_dir}/th07_replay_autoplay/build/th07_hook.dll",
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
    parser.add_argument("--max-attempts", type=int, default=3, help="異常検知時の最大試行回数")
    parser.add_argument(
        "--max-duplicate-rate", type=float, default=30.0,
        help="録画開始15秒以降の重複フレーム率(%%)がこれを超えたら処理落ちとみなし自動リトライする",
    )
    args = parser.parse_args()

    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    if args.progress_dir:
        os.makedirs(args.progress_dir, exist_ok=True)

    config = build_config()
    success = record_with_retry(
        config, args.replay_path, args.output,
        progress_dir=args.progress_dir, expected_duration_seconds=args.expected_duration_seconds,
        max_attempts=args.max_attempts, max_duplicate_rate=args.max_duplicate_rate,
        log=log,
    )
    if not success:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
