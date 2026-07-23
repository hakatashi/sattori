#!/usr/bin/env python3
"""th08(永夜抄)リプレイのヘッドレス録画パイプライン(Sattori ワーカー)。

Issue #13 対応。touhou-recorder での事前検証(reports/22〜26)を踏まえた実装:

- ゲームデータは公式アップデータ ver1.00d 相当のものを使う(タイトル資産アーカイブに
  `games/th08` として配置。ver1.00a はリプレイ再生中に内部fpsが数百〜数千に暴走する
  既知の不具合があり、ver1.00d で事実上解消した、reports/23)。
- 録画対象リプレイを正規スロット名 `th8_ud0000.rpy` として配置する方式は、th07の
  `th7_ud0000.rpy` と同じ命名則を踏襲したもの。touhou-recorder の実ゲームデータで
  実機検証済み(スペルプラクティスリプレイを配置し、実際にそのリプレイのゲームプレイ
  画面まで遷移することをスクリーンショットで確認した)。
- fps暴走の残存ケース検知・処理落ちの早期検知・自動リトライ・音声/映像の別プロセス
  録画(reports/26。単一ffmpegでのA/V同期がth08の描画タイミングを律速し、AWS環境で
  重複フレーム率が85%超まで悪化する不具合への対策)は th07 と共通の実装
  (`recording_common.py`)を使う。
"""
import argparse
import os

from recording_common import GameConfig, log_with_prefix, record_with_retry

REPO = os.path.dirname(os.path.abspath(__file__))


def log(msg):
    log_with_prefix("record_th08", msg)


def build_config():
    instance_dir = os.environ.get("SATTORI_INSTANCE_DIR", f"{REPO}/instances/th08-recording")
    game_dir_src = os.environ.get("SATTORI_GAME_DIR", f"{REPO}/games/th08")
    mod_dir = os.environ.get("SATTORI_MOD_DIR", f"{REPO}/mods")
    return GameConfig(
        game_id="th08",
        display=os.environ.get("SATTORI_DISPLAY", ":98"),
        wineprefix=os.environ.get("WINEPREFIX", f"{REPO}/prefixes/th08-wined3d-gl"),
        instance_dir=instance_dir,
        game_dir_src=game_dir_src,
        canonical_slot="th8_ud0000.rpy",
        injector_path=f"{mod_dir}/common/build/injector.exe",
        hook_dll_path=f"{mod_dir}/th08_replay_autoplay/build/th08_hook.dll",
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--replay-path", required=True, help="録画対象リプレイの絶対パス(任意ファイル名)")
    parser.add_argument("--output", required=True, help="出力する mp4 のパス")
    parser.add_argument("--watermark", default=None, help="ウォーターマーク動画(webm, VP9アルファ)のパス。未指定なら合成しない")
    parser.add_argument("--watermark-width", type=int, default=285)
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
        watermark_path=args.watermark, watermark_width=args.watermark_width,
        progress_dir=args.progress_dir, expected_duration_seconds=args.expected_duration_seconds,
        max_attempts=args.max_attempts, max_duplicate_rate=args.max_duplicate_rate,
        log=log,
    )
    if not success:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
