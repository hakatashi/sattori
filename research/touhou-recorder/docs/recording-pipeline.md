# 録画パイプラインと品質評価仕様

このドキュメントでは、`recorder/` パッケージを中心とする録画パイプラインの実装仕様および録画品質の評価手法をまとめます。

## モジュール構成

録画パイプラインの実装本体はリポジトリ直下の `recorder/` パッケージにあります（フェーズ83でモジュール分割、`reports/83`）。CLIの `scripts/25_record_replay_e2e_multigame.py` は `recorder.cli.main()` を呼ぶだけの互換シムで、フラグ・既定値・終了コードは従来どおりです。

| モジュール | 責務 |
|---|---|
| `recorder/config.py` | `GameConfig`（タイトルごとの差分）とパイプライン共通の既定値 |
| `recorder/games.py` | タイトル別の設定レジストリ（値の根拠コメント込み） |
| `recorder/options.py` | `RecordingOptions`（1回の録画実行への指示） |
| `recorder/timing.py` | 低速録画（`FPS_LIMIT_TARGET_HZ`）の実時間スケーリング |
| `recorder/instance.py` | Xディスプレイ・instanceディレクトリ・注入コマンドの準備 |
| `recorder/process.py` | ゲームプロセスの探索・thpracのアタッチ・Wineの後片付け |
| `recorder/window.py` | ウィンドウ検出とクロップ座標の確定 |
| `recorder/modlog.py` | MODログのマーカー待ち・fps暴走検知 |
| `recorder/vision.py` | 画面キャプチャと画素比較（終了検知の判定材料） |
| `recorder/stutter.py` | 処理落ちの早期検知（短間隔サンプリング） |
| `recorder/ffmpeg.py` | 録画・結合・重複フレーム率計測のffmpeg呼び出し |
| `recorder/chapters.py` | MODログの `StageMarker` から動画チャプターを生成 |
| `recorder/pipeline.py` | 録画1回ぶんの試行（`attempt_recording`） |
| `recorder/runner.py` | 実行モード（リトライ付き録画・固定秒数録画・統計取り） |
| `recorder/cli.py` | コマンドライン |

新規タイトルを追加する場合は `recorder/games.py` に `GameConfig(...)` を1件足すだけで済みます（フィールドの意味は `recorder/config.py` の定義を参照）。Pythonから直接使う場合は次のようにします：

```python
from recorder import RecordingOptions, load_game_config, record_with_retry

config = load_game_config("th10")
options = RecordingOptions(replay="th10_07.rpy",
                           output="/mnt/cache3/sattori-th10-verify/video.mp4")
record_with_retry(config, options)
```

本番サービスSattoriの録画パイプライン（`../sattori/worker/recording`）とはモジュール名・責務の切り方をおおむね揃えてあります（片方で見つかった不具合をもう片方へ移植しやすくするため）。

## 録画パイプラインの実装仕様

### 1. ウィンドウ座標の取得とクロップ
- ウィンドウのキャプチャ座標・サイズは `xdotool getwindowgeometry` ではなく、`xwininfo -id <WINDOW_ID>` の `Absolute upper-left X/Y` および幅・高さを取得して決定します。
- openboxの装飾枠や配置オフセットを正しく反映するため、`xdotool windowmove` 実行後は必ず `xwininfo` で再取得します。
- 録画開始前にMODログの `WaitForStableWindow: stable` を確認します（録画対象領域内でウィンドウが再作成されると、ffmpegのx11grabが重複フレームだらけになるため）。

### 2. リプレイ終了検知
録画パイプラインでは以下の手法でリプレイ再生終了を自動検知します：

- **画面静止 (MAD) 検知**:
  - 各フレーム間の平均絶対差分 (Mean Absolute Difference) を計算。
  - 既定値: MAD閾値 2.0、`STILL_CONSECUTIVE_REQUIRED` = 8回 (約16秒)。
  - `still_detect_exclude_rect`: タイトルごとの明滅・アニメーション領域（UI枠や星エフェクト等）をMAD計算から除外（th11, th12, th20等で使用）。
- **テンプレート画像照合 (高速終了検知)**:
  - リプレイ終了後のリプレイ選択画面テンプレート画像（`assets/replay_end_templates/`）と照合。
  - 照合成功時は静止待ち（約20秒）が約4.5秒に短縮。
  - 対象: th06, th06c, th07, th08, th09, th10。
  - `end_template_rect`: 一覧画面内の可変領域（スコア・日付等）を除外して誤不一致を防止。
- **サブストリームによる終了検知ポーリング (`poll_side_stream`)**:
  - 通常の `grab_frame()` はポーリングのたびにffmpegプロセスを起動するため、本録画のx11grabと干渉して周期的なフレーム落ちを引き起こすことがあります。
  - 高解像度・高負荷タイトル（th06nc等）では、`poll_side_stream: True` を指定し、録画用ffmpegの `filter_complex` から分岐させた低負荷サブストリーム（8fps, 160x120, gray）から読み取る方式を使用します。

### 3. 低速録画機能
処理落ちが激しいタイトル向けに、半速（30fps等）でゲームを動作させてキャプチャし、後から等速化する低速録画機能を備えています（`FPS_LIMIT_TARGET_HZ=30`）。

- **動的閾値スケーリング**:
  - 30fps動作時は原理的に約50%が重複フレームとなるため、早期処理落ち検知（`probe_stutter` の `STUTTER_DUP_FRACTION_THRESHOLD`）および録画完了後の最終判定（`--max-duplicate-rate`、30fps時は既定65%）は、`MENU_TIME_SCALE` に応じて動的にスケールされます。
- **タイムアウトのスケーリング**:
  - ゲーム内時間引き伸ばしに伴い、ウィンドウ安定待ちやシーケンスタイムアウトも `MENU_TIME_SCALE` に応じてスケールされます。

### 4. ステージ開始時刻の自動出力
録画と同時に各ステージの開始時刻を検出・記録します（`<出力名>.chapters.txt` / `.chapters.json`）。
- **検出方式**:
  - ステージ番号変数ポーリング方式: th07, th08等
  - アセットロードバースト検出方式: th20等
- **新規タイトルの判定**: `STAGE_PROBE=1` と `scripts/49_stage_probe_run.py` でプローブを取得し、`scripts/49_stage_probe_analyze.py` で適合方式を判定します。

### 5. フレーム同期キャプチャ(`--frame-sync`、試験実装)
ゲームを実時間で動かして外から取り込む代わりに、MODがゲームの1フレームごとにバックバッファを読み出してFIFOへ書き、書き終わりしだい次のフレームへ進める方式(reports/104・105)。描画・読み出し・エンコードの遅いほうが律速になり、ゲームは可変速で進む。落ちフレームは原理的に起きず、録画後に「MODが書いたフレーム数=動画のフレーム数」を照合する。

- 実装: `mods/common/frame_sync_hook`(仮想時計・読み出し)、`mods/common/frame_sync_audio`(仮想音声デバイス)、`recorder/framesync.py`(FIFO・ffmpeg・動画時間基準の終了検知)。`FRAME_SYNC_PIPE`未設定なら既存の録画に影響しない。
- 対応済み: th15・th12(D3D9)。MODに`InstallFrameSyncHook()`と、キー操作の最後の`FrameSyncSetUnthrottled(true)`が要る。
- 音声はPulseAudioからではなく、MOD内の仮想音声デバイス(`mods/common/frame_sync_audio`)がDirectSoundのバッファを仮想で再生し、1フレームにつき735サンプルをミックスして書く(reports/107)。長さは映像のフレーム数と必ず一致し、同期マーカーは使わない。倍速・低速録画とは併用できない。
- 検証: `scripts/105_run_frame_sync.sh`、集計は`scripts/105_frame_sync_summary.py`。

---

## 録画品質の評価手法

録画完了後の品質評価は、単一指標に依存せず以下の観点を組み合わせて多角的に行います：

### 1. 重複フレーム率
- 計測スクリプト: `scripts/measure_duplicate_frame_rate.sh`
- **注意点**: 重複フレーム率は区間依存性があり、短時間（60秒等）では1%〜17%程度ブレることがあります。必ず録画全体または複数区間の平均で評価します。

### 2. 理論尺比較（プレイ時間の過不足）
- リプレイファイルから `frameCount`（60fps基準の総フレーム数、`@sattori/touhou-replay-parser` で取得可能）を算出し、実測プレイ時間と比較します。
  - 実測プレイ時間 = 総録画時間 − メニュー操作〜シーケンス完了までの経過秒 − 終了静止待機時間（既定16秒）
- **重要性**: 重複フレーム率（mpdecimate）は画面全体が完全一致するフレームしか検知できないため、背景が常に動いているゲームでは「進行が実時間に対して間延びする処理落ち」を見逃します（th12等で実例あり）。
- **系統差の考慮**: th06cやth06nc（Extra）のように、仕様上マイナス側に出るタイトルでは「超過方向（プラス側）」の検出にのみ使用します。

### 3. カクつきの周期性分析
- 分析スクリプト: `scripts/81_analyze_stutter_periodicity.py`
- mpdecimateでは、ゲーム本来の静止演出（会話、BGMロード、リザルト）とキャプチャ脱落を区別できません。
  - **ゲーム内容由来の静止**: 散発的で周期性（位相集中度 $R$）が低く、1回あたりのフレーム数が多い（数十〜100フレーム）。
  - **キャプチャ脱落**: 等間隔で周期性（$R$）が高く、1回あたり数フレーム。
- 単発バーストは `--list-bursts` で時刻を出力して動画を目視確認します。

### 4. 空動画チェック
openboxがウィンドウを画面外（負の座標）に配置すると、x11grabが1フレームも取れず空動画になる場合があります。パイプラインが正常終了を報告しても、出力ファイルサイズおよび動画が空でないことを必ず確認します。

### 5. アップスケール方針
録画と同時に720pへアップスケールすると重複フレーム率が悪化するため、録画完了後に `scripts/21_upscale_to_720p.sh` 等でオフライン変換します。

## 参照レポート

- `reports/11_phase11_e2e_replay_recording.md`
- `reports/12_phase12_stutter_root_cause_and_fix.md`
- `reports/13_phase13_recording_quality_improvements.md`
- `reports/21_phase21_upscale_to_720p_verification.md`
- `reports/33_phase33_replay_end_detection_false_positive_fix.md`
- `reports/34_phase34_end_detection_latency_and_cross_replay_validation.md`
- `reports/47_phase47_th20_slowmotion_timescale_poc.md`
- `reports/49_phase49_stage_start_timestamp_detection.md`
- `reports/67_phase67_th12_theoretical_length_comparison_and_lunatic_verification.md`
- `reports/69_phase69_th09_slowmo_fps_display_correction.md`
- `reports/90_phase90_fps_display_fix_and_th06c_speedup.md`(倍速録画時のfps表示補正、vpatchの`CalcFPS`)
- `reports/81_phase81_th06nc_aws_gpu_bringup.md`
- `reports/83_phase83_recording_pipeline_modularization.md`
- `reports/104_phase104_frame_sync_capture_feasibility.md`・`reports/105_phase105_frame_sync_capture_poc.md`・`reports/107_phase107_frame_sync_virtual_audio.md`(フレーム同期キャプチャ)
