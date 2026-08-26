#!/usr/bin/env python3
"""th11(地霊殿)リプレイのヘッドレス録画パイプライン(Sattori ワーカー)。

touhou-recorder での事前検証(reports/35〜39)を踏まえた実装:

- th11はth08と同じwined3d/OpenGLレンダリング経路でXvfb上で正常に動作し、日本語
  フォント(MS Gothic)もth08用に導入済みの配置・レジストリ登録がそのまま有効に働く
  (reports/35)。
- メニュー自動操作はth06/07/08と異なり、DirectInput GetDeviceStateフックではなく
  **GetKeyboardStateフック**が必要(TH10以降のエンジンで実際の入力ポーリングが
  DirectInputからWin32のGetKeyboardState()経由に変わったため)。
  `mods/common/dinput_hook.h/.cpp`に追加した`InstallKeyboardStateHook`/`PressVKey`を
  `mods/th11_replay_autoplay/dllmain.cpp`が使う(reports/35)。
- リプレイ一覧画面には「組み込みリプレイ(No.01〜、ファイル名の数字でスロットが
  決まる)」と「ユーザーリプレイ(ud0000〜、右キーで切り替わる別タブ)」の2つの
  タブがあり、実際のプレイヤー録画リプレイは後者に属する。MODはリプレイ一覧に
  入った後、右キーでユーザーリプレイタブへ切り替えてから1件目を選択するシーケンス
  (Down×2→Enter→Right→Enter→Enter)になっており、投入リプレイは
  `th11_ud0000.rpy`という固定名で配置する必要がある(reports/35)。
- タイトルロゴアニメーションの待機時間はth08の1500msでは不足し、**6000ms**必要
  (待機不足だと意図しないメニュー項目に迷い込む誤動作が発生する、reports/35)。
- th11の終了画面は「直前ゲームプレイ画面の凍結+Pause Menuオーバーレイ」であり、
  th06/07/08のような内容非依存の専用リプレイ選択画面ではない(スペルカード名等の
  背景がリプレイ内容によって変わる)。このためテンプレート照合には不向きと判断し、
  **end_templateを設定せず画面静止検知のみで運用する**方針を採用した(reports/36)。
  ワーカーイメージに`assets/replay_end_templates/th11.png`を配置しないことで、
  `GameConfig.end_template_path`の既定値解決(recording_common.load_end_template())が
  自動的にNoneを返し、画面静止のみ判定にフォールバックする。
- 画面静止検知のみに依存する副作用として、Pause Menu画面で現在選択中のメニュー
  項目の文字が明滅し続け、MADが閾値をわずかに超え続けて自然終了を検知できない
  事例が実機で発生した(`th11_ud16gm.rpy`、40分のハードタイムアウトに到達、
  reports/37)。この明滅は640x480原座標で(70,288)-(188,318)の矩形に収まることが
  判明したため、`still_detect_exclude_rect`でこの矩形を静止判定のMAD計算から除外する
  (`recording_common.build_still_mask()`/`mad_masked()`、reports/38)。
- MS明朝(`msmincho.ttc`)がWINEPREFIXに配置・レジストリ登録されていないと、NPC会話
  シーン等でフォントの誤り(書体・全角/半角括弧)が発生する。`setup_wineprefix.sh`の
  MS明朝対応オプションで登録すること(reports/38、`worker/docs/titles/th11.md`参照)。
- 文字輪郭のジャギー(WineのFreeTypeベースAAが実機Windowsより粗い)は原因調査済み
  だが対策なし・許容する既知の制約として残る(reports/39、実装対応不要)。
- 日本語ロケール必須・fps暴走の検知(th11のMODもFpsMonitorを組み込み済み)・処理落ちの
  早期検知・自動リトライ・音声/映像の別プロセス録画は th06/07/08 と共通の実装
  (`recording_common.py`)をそのまま使う。
"""
import argparse
import os

import pulse
from recording_common import GameConfig, log_with_prefix, record_with_retry

REPO = os.path.dirname(os.path.abspath(__file__))


def log(msg):
    log_with_prefix("record_th11", msg)


def build_config(pulse_sink):
    instance_dir = os.environ.get("SATTORI_INSTANCE_DIR", f"{REPO}/instances/th11-recording")
    game_dir_src = os.environ.get("SATTORI_GAME_DIR", f"{REPO}/games/th11")
    mod_dir = os.environ.get("SATTORI_MOD_DIR", f"{REPO}/mods")
    return GameConfig(
        game_id="th11",
        pulse_sink=pulse_sink,
        display=os.environ.get("SATTORI_DISPLAY", ":99"),
        wineprefix=os.environ.get("WINEPREFIX", f"{REPO}/prefixes/th11-wined3d-gl"),
        instance_dir=instance_dir,
        game_dir_src=game_dir_src,
        canonical_slot="th11_ud0000.rpy",
        injector_path=f"{mod_dir}/common/build/injector.exe",
        hook_dll_path=f"{mod_dir}/th11_replay_autoplay/build/th11_hook.dll",
        # Pause Menu画面の選択カーソル明滅を静止判定から除外する(モジュール
        # docstring・reports/37・38参照)。
        still_detect_exclude_rect=(70, 288, 188, 318),
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
        log=log,
    )
    if not success:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
