"""東方作品のリプレイをヘッドレス環境で自動再生・録画する検証用パイプライン。

`Xvfb`(またはGPU描画面)+ `Wine` + DLL注入MOD + `ffmpeg`を組み合わせて、リプレイ
ファイル1件から動画を作る。新規タイトルの対応検証・録画品質の評価・クラウド実機検証は
すべてこのパッケージ経由で行う(手順は`docs/new-title-checklist.md`)。

もとは`scripts/25_record_replay_e2e_multigame.py`という1ファイルのスクリプトだったが、
フェーズ25以降の検証のたびに追記を重ねて2000行近くになったため、責務ごとに分割した。
CLIの互換性は保っており、`scripts/25_record_replay_e2e_multigame.py`は`cli.main()`を
呼ぶだけのシムとして残してある。本番サービスSattoriの録画パイプライン
(`../sattori/worker/recording`)とは、モジュール名・責務の切り方をおおむね揃えてある
(片方で見つかった不具合を他方へ移植しやすくするため)。

モジュール構成:

    config     GameConfig(タイトルごとの差分)とパイプライン共通の既定値
    games      タイトル別の設定レジストリ(値の根拠コメント込み)
    options    RecordingOptions(1回の録画実行への指示)
    timing     低速録画(FPS_LIMIT_TARGET_HZ)の実時間スケーリング
    log        共通ロガー
    instance   Xディスプレイ・instanceディレクトリ・注入コマンドの準備
    process    ゲームプロセスの探索・thpracのアタッチ・Wineの後片付け
    window     ウィンドウ検出とクロップ座標の確定
    modlog     MODが書き出すログの読み取り(マーカー待ち・fps暴走検知)
    vision     画面キャプチャと画素比較(終了検知の判定材料)
    stutter    処理落ちの早期検知(短間隔サンプリング)
    ffmpeg     録画・結合・重複フレーム率計測のffmpeg呼び出し
    chapters   MODログのStageMarkerから動画チャプターを生成
    pipeline   録画1回ぶんの試行
    runner     実行モード(リトライ付き録画・固定秒数録画・統計取り)
    cli        コマンドライン

ライブラリとして使う場合:

    from recorder import RecordingOptions, load_game_config, record_with_retry

    config = load_game_config("th10")
    options = RecordingOptions(replay="th10_07.rpy",
                               output="/mnt/cache3/sattori-th10-verify/video.mp4")
    record_with_retry(config, options)

**録画した動画は`/mnt/cache3/<用途>/`配下に置くこと**(作業マシンのルートFSは常時
98%前後で逼迫しており、フル尺録画をruns/に置くとディスク枯渇で異常終了する)。

設計上とくに重要な前提(いずれも実機検証で痛い目を見た結果):

  - **後片付けの保証**: 録画処理は必ずtry/finallyで`process.kill_wine_and_wait()`を
    通る。放置するとホストのsystem D-Busのメッセージキューを枯渇させ、システム全体の
    ハングを引き起こす(reports/55)。
  - **映像と音声は別プロセスで録る**: 1つのffmpegで同時取り込みすると、AWS環境で
    th08の重複フレーム率が85%超に悪化する(reports/26)。分離に伴う音ズレは
    `-copyts`のstart_timeを毎回実測して補正する(reports/28)。
  - **終了検知は2系統**: リプレイ選択画面のテンプレート照合(可能なタイトル)と
    画面静止検知(フォールバック)。静止のみだとステージクリア画面を終了と
    誤判定しうる(reports/33)。
  - **低速録画では監視側の時間もスケールする**: MOD内部の待機だけを伸ばしても、
    それを監視する側のタイムアウト・猶予が等倍のままでは成立しない(reports/47)。
"""
from .config import GameConfig
from .games import GAME_CONFIGS, game_ids, load_game_config
from .log import log
from .options import RecordingOptions
from .pipeline import RecordingResult, attempt_recording
from .runner import record_fixed_seconds, record_with_retry, run_stats
from .timing import MENU_TIME_SCALE

__all__ = [
    "GAME_CONFIGS",
    "GameConfig",
    "MENU_TIME_SCALE",
    "RecordingOptions",
    "RecordingResult",
    "attempt_recording",
    "game_ids",
    "load_game_config",
    "log",
    "record_fixed_seconds",
    "record_with_retry",
    "run_stats",
]
