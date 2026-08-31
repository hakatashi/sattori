"""`record_thNN.py` が共有する CLI(引数定義・ロガー・録画の呼び出し)。

各タイトルのスクリプトは「`GameConfig` を組み立てる `build_config()`」だけを持ち、
コマンドライン引数の定義とその配線はすべてここにある。引数を1つ足すときに
6ファイルを編集しなくて済むようにするため(Issue #188)。
"""
import argparse
import os
import time

import pulse

from .pipeline import record_with_retry


def log_with_prefix(prefix, msg):
    print(f"[{prefix} {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def build_parser():
    """全タイトル共通の引数定義。**タイトルごとの差は無い**(あってはならない)。"""
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
        help="録画開始15秒以降の重複フレーム率(%%、**等倍換算**)がこれを超えたら処理落ちとみなし"
             "自動リトライする。低速録画では生データの重複率が構造的に上がるため、閾値の方を"
             "スケールに応じて換算する(recording.timing.duplicate_rate_threshold_for_raw())",
    )
    return parser


def run(game_id, build_config):
    """`record_thNN.py` のエントリポイント。録画に失敗したら SystemExit(1) を送出する。

    `build_config` は pulse_sink を1つ受け取って `GameConfig` を返す呼び出し可能オブジェクト
    (各 `record_thNN.py` が定義する)。
    """
    args = build_parser().parse_args()

    def log(msg):
        log_with_prefix(f"record_{game_id}", msg)

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
