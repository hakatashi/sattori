#!/usr/bin/env python3
"""th20(錦上京)リプレイのヘッドレス録画パイプライン(Sattori ワーカー)。

touhou-recorder での事前検証(reports/44〜48、Issue #87)を踏まえた実装:

- **メニュー自動操作はth11と同じGetKeyboardStateフック経路**。th20.exeのインポート
  テーブルはth11と同じTH10+系エンジンのパターン(DINPUT8.dll と USER32.dll!
  GetKeyboardState の両方を持ち、実際の入力ポーリングは後者)。リプレイ一覧も
  「組み込みリプレイ / ユーザーリプレイ」の2タブ構成で、キーシーケンスは
  Down×3→Enter→Right→Enter→Enter(th11のDown×2と異なるのはメインメニューの
  項目数の違い)。投入リプレイは`th20_ud0000.rpy`という固定名で配置する(reports/44)。
- **タイトルロゴアニメーションの待機は10000ms必要**。th11の6000msでは足りず、
  メニュー項目が操作可能になる前にDown入力が空振りする(reports/44)。この待機は
  MOD側(`mods/th20_replay_autoplay/dllmain.cpp`)にあり、低速録画時は
  `FPS_LIMIT_TARGET_HZ`から算出した比率で自動的に伸びる。
- **cfgとリプレイは`%APPDATA%/ShanghaiAlice/th20/`から読まれる**。th125以降の
  エンジンの仕様変更で、ゲーム本体ディレクトリに置いても読まれない。cfgが無いと
  「解像度を選択してください」の初回起動ダイアログ(246x234の小さなウィンドウ)で
  止まり、ウィンドウ検出に失敗する(reports/44・46)。`uses_appdata_profile=True`で
  `recording_common.prepare_instance()`が配置する。
- **Xvfbの画面サイズは1400x1100が要る**。th14以降、内部描画解像度が960p相当へ
  上がっており、th20は1280x960ウィンドウで起動する。既定の800x600のままだと
  x11grabが起動に失敗する(reports/44)。
- **終了検知はテンプレート照合を使わず画面静止検知のみ**(th11と同じ理由。終了画面が
  リプレイ内容に依存する)。ただしth20はリプレイ終了後も2箇所で背景アニメーションが
  継続するため、両方を静止判定のMAD計算から除外する(reports/45。除外しないと
  MADが閾値を超え続け、40分のハードタイムアウトまで終了を検知できない)。
- **Presentフックによるフレームレート制御が必須**(`mods/common/fps_limiter_hook.*`)。
  AWS実機(Intel Xeon/Nitro仮想化)ではth20のフレームペーシング計算が崩れ、
  ゲーム内fpsが常時75fps前後まで上振れして**リプレイが早回しで録画される**不具合が
  ある(reports/46。th20はレンダリングfpsとゲームロジック更新が直結しているため、
  fpsの上振れがそのままゲーム進行の早回しになる)。MODは既定で60Hzへスロットルする。
- **低速録画(Issue #68)はこの仕組みの応用**。同じフックの目標fpsを下げると、
  ゲーム進行ごとスローモーション化して実時間あたりのCPU負荷が下がり、等倍では
  処理落ちしていた高負荷区間(最低19.8fps)が安定する(reports/47)。有効化は
  起動側が渡す`FPS_LIMIT_TARGET_HZ`のみで決まり、このスクリプトに分岐は無い
  (`recording_common.slow_motion_scale()`・`convert.py`)。
- **デシンク(リプレイずれ)が起きやすいタイトル**だが、有志製パッチ**thprac**を
  ゲーム起動直後にアタッチすることで対策している(reports/50、Issue #105)。デシンクの
  主因はZUN側のバグ(未初期化AnmVMの残骸漏れ・宝珠タイムアウト時のuse-after-free等)で
  挙動が非決定的になることであり、thpracはこれらをGUI操作なしで常時修正する。
  reports/50の実機検証では、ずれていたリプレイ3本すべてが記録時スコアと完全一致し、
  元々ずれていなかった1本にも回帰は無かった(尺も23〜49%短縮)。有効化は
  `thprac_exe`を指定するだけで、失敗しても従来どおりthprac無しで録画を続行する。
  **ただし「もう絶対にずれない」ことの保証ではない**ため、ページAの注意書きは
  残してある(`apps/web`、Issue #87)。
- 日本語ロケール必須・fps暴走の検知・処理落ちの早期検知・自動リトライ・音声/映像の
  別プロセス録画は th06/07/08/11 と共通の実装(`recording_common.py`)をそのまま使う。
"""
import argparse
import os

import pulse
from recording_common import GameConfig, log_with_prefix, record_with_retry

REPO = os.path.dirname(os.path.abspath(__file__))


def log(msg):
    log_with_prefix("record_th20", msg)


def build_config(pulse_sink):
    instance_dir = os.environ.get("SATTORI_INSTANCE_DIR", f"{REPO}/instances/th20-recording")
    game_dir_src = os.environ.get("SATTORI_GAME_DIR", f"{REPO}/games/th20")
    mod_dir = os.environ.get("SATTORI_MOD_DIR", f"{REPO}/mods")
    return GameConfig(
        game_id="th20",
        pulse_sink=pulse_sink,
        # 他タイトル(:96〜:99)と重ならない番号。同一ホストでの並列録画で映像が
        # 混ざらないようにするためタイトルごとに固定する。
        display=os.environ.get("SATTORI_DISPLAY", ":95"),
        wineprefix=os.environ.get("WINEPREFIX", f"{REPO}/prefixes/th20-wined3d-gl"),
        instance_dir=instance_dir,
        game_dir_src=game_dir_src,
        canonical_slot="th20_ud0000.rpy",
        injector_path=f"{mod_dir}/common/build/injector.exe",
        hook_dll_path=f"{mod_dir}/th20_replay_autoplay/build/th20_hook.dll",
        # 1280x960ウィンドウ + ウィンドウ装飾分の余白(モジュール docstring・reports/44)。
        xvfb_screen="1400x1100x24",
        # th125以降の仕様。cfg/リプレイは%APPDATA%配下から読まれる(reports/44)。
        uses_appdata_profile=True,
        # リプレイ終了後もアニメーションが継続する2箇所を静止判定から除外する
        # (1280x960のウィンドウ座標系。reports/45)。
        still_detect_exclude_rect=[
            (68, 245, 68 + 406, 245 + 604),
            (851, 488, 851 + 420, 488 + 420),
        ],
        # デシンク対策(reports/50、Issue #105)。ゲーム起動直後にアタッチする
        # (`recording_common.attach_thprac()`)。games/th20/ に同梱しておくこと。
        thprac_exe="thprac.v2.3.0.3.exe",
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
        help="録画開始15秒以降の重複フレーム率(%%、**等倍換算**)がこれを超えたら処理落ちとみなし"
             "自動リトライする。低速録画では生データの重複率が構造的に上がるため、閾値の方を"
             "スケールに応じて換算する(recording_common.duplicate_rate_threshold_for_raw())",
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
