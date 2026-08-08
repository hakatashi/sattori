#!/usr/bin/env python3
"""th06(紅魔郷)リプレイのヘッドレス録画パイプライン(Sattori ワーカー)。

touhou-recorder での事前検証(reports/30〜32)を踏まえた実装:

- th06はWine/最新Windows環境で頻発する既知の互換性バグ(D3D8のvsync検出関連)により、
  そのままでは wined3d(llvmpipe) 上で画面が白一色のまま固まってしまう(reports/30)。
  ファン製パッチ「VsyncPatch」(`vpatch_th06.dll`)を MOD 本体(`th06_hook.dll`)より
  前に同一プロセスへ注入することで解消する(`GameConfig.extra_dlls`、
  `mods/common/injector.cpp`は複数DLLの順次注入に対応済み)。`vpatch_th06.dll`自体は
  タイトル資産アーカイブの`games/th06`に同梱し、`recording_common.prepare_instance()`
  のrsyncで自動的にinstance_dirへコピーされる想定(個別コピー不要)。
- th06のタイトル画面は最初からアトラクトモードのデモプレイを表示しており、th07/th08と
  異なりメニュー自体がまだ出ていないため、MOD(`th06_replay_autoplay/dllmain.cpp`)は
  Down連打の前にメニュー表示のためのEnter押下を1回余分に行う(reports/31)。
- 日本語ロケール(`LANG=ja_JP.UTF-8`)必須である点・fps暴走の残存ケース検知・処理落ちの
  早期検知・自動リトライ・音声/映像の別プロセス録画は th07/th08 と共通の実装
  (`recording_common.py`)をそのまま使う(touhou-recorderの検証ではth06にfps暴走の
  兆候は見られなかったが、検知ロジック自体はth07同様に保険として残す)。
- **実行ファイル名は元の`東方紅魔郷.exe`のまま使う(th07/th08のような`th{N}.exe`への
  リネームはしない)**。VsyncPatch(`vpatch_th06.dll`)は対象プロセスの実行ファイル名を
  検証しているらしく、`th06.exe`へリネームすると白画面ハング(reports/30)が再発する
  ことを実機検証で確認した(`WaitForStableWindow`が`stable`に到達せずCPU使用率100%で
  張り付き続けたが、`東方紅魔郷.exe`のままだと約3.5秒で正常に安定した)。このため
  `GameConfig.game_exe`を明示的に`"東方紅魔郷.exe"`に指定する。ただしLinuxの
  `/proc/PID/comm`は15バイトで切り詰められ、UTF-8で18バイトの`東方紅魔郷.exe`は
  末尾の`.exe`が欠落した`東方紅魔郷`(15バイトちょうど)になるため、`pgrep -x`/
  `pkill -x`用に`GameConfig.process_name`を別途`"東方紅魔郷"`(拡張子なし)に指定する
  (touhou-recorder reports/31)。

未検証事項: 録画対象リプレイを正規スロット名(`th6_ud0000.rpy`)として配置する方式は
th07/th08の命名則(`th{N}_ud####.rpy`)を踏襲したものだが、th08の時のようにこの名前が
「1件目のリプレイ」として実際に認識・選択されることを実ゲームデータで検証できていない
(touhou-recorderのreports/30〜32では既存の numbered replay ファイル名(`th6_02.rpy`等)
でのみ検証しており、任意ファイル名→正規スロット名の置き換え自体は未検証。AGENTS.md
§10参照)。本番投入前に実リプレイでのスモークテストを推奨する。
"""
import argparse
import os

import pulse
from recording_common import GameConfig, log_with_prefix, record_with_retry

REPO = os.path.dirname(os.path.abspath(__file__))


def log(msg):
    log_with_prefix("record_th06", msg)


def build_config(pulse_sink):
    instance_dir = os.environ.get("SATTORI_INSTANCE_DIR", f"{REPO}/instances/th06-recording")
    game_dir_src = os.environ.get("SATTORI_GAME_DIR", f"{REPO}/games/th06")
    mod_dir = os.environ.get("SATTORI_MOD_DIR", f"{REPO}/mods")
    return GameConfig(
        game_id="th06",
        pulse_sink=pulse_sink,
        display=os.environ.get("SATTORI_DISPLAY", ":96"),
        wineprefix=os.environ.get("WINEPREFIX", f"{REPO}/prefixes/th06-wined3d-gl"),
        instance_dir=instance_dir,
        game_dir_src=game_dir_src,
        canonical_slot="th6_ud0000.rpy",
        injector_path=f"{mod_dir}/common/build/injector.exe",
        hook_dll_path=f"{mod_dir}/th06_replay_autoplay/build/th06_hook.dll",
        # wined3dの白画面ハング回避に必須(reports/30)。hook_dllより前に注入する。
        extra_dlls=("vpatch_th06.dll",),
        # th07/th08と異なりリネームしない(VsyncPatchが実行ファイル名を検証している
        # らしく、リネームすると白画面ハングが再発するため。モジュールdocstring参照)。
        game_exe="東方紅魔郷.exe",
        # pgrep/pkill専用。/proc/PID/commの15バイト切り詰め対策(モジュールdocstring参照)。
        process_name="東方紅魔郷",
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
        log=log,
    )
    if not success:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
