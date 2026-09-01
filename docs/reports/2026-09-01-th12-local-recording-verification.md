# th12（東方星蓮船）録画対応：sattori本体コードでのローカル実機検証

- **検証日**: 2026-09-01
- **対象**: th12（東方星蓮船）録画対応（Issue #76）。`worker/mods/th12_replay_autoplay/`・
  `worker/record_th12.py`の新規追加、`recording.window.find_window()`の
  `force_window_map`対応（ウィンドウ最小化バグ対策）
- **環境**: ローカル開発機（HakataMatrix）、Wine + Xvfb + ffmpeg。ゲーム本体・WINEPREFIX・
  VsyncPatchはtouhou-recorderの検証済みアセット（reports/61〜67）をそのまま流用
- **結論**: sattori本体の録画パイプライン（`worker/record_th12.py`）でth12のフル尺録画・
  ウィンドウ最小化バグ対策・メニュー自動操作・VsyncPatch注入・終了検知（画面静止）・
  スコア完全一致検証のいずれも実機で成功を確認した。

touhou-recorderでのタイトル対応検証（reports/61〜67）を踏まえて実装したth12録画対応
（MOD新規作成・`GameConfig.force_window_map`の新設・VsyncPatch常時有効化）を、
sattoriリポジトリ自身のコードで再検証したもの。

## 目的

Issue #76の実装（`worker/mods/th12_replay_autoplay/`・`worker/record_th12.py`・
`recording/config.py`・`recording/window.py`の拡張）が、touhou-recorderのPoCスクリプト
ではなくsattori本体のコードで実際に動作することを確認する。

## 事前準備

作業開始前に`systemctl status sattori-home-worker`を確認したところ稼働中（直前のジョブは
完了済みで待機中）だったため、`ps aux`でwine/ffmpeg残存プロセスが無いことを確認した上で
`sudo systemctl stop sattori-home-worker`を実行して停止した。

touhou-recorderの`games/th12/`（VsyncPatch一式・`th12_02.rpy`）・
`prefixes/th12-wined3d-gl/`をローカルの`worker/games/th12/`・
`worker/prefixes/th12-wined3d-gl/`へrsyncでコピーし（本番はS3タイトル資産アーカイブ経由、
`upload-title-assets` skill参照）、`mods/th12_replay_autoplay/dllmain.cpp`を
mingw-w64でビルドした（`build-mods` skillに記載のコマンド）。

## 短時間動作確認（60〜90秒、`th12_02.rpy`）

`force_window_map=True`の効果・入力注入・メニュー自動操作の疎通を確認する目的で、
外側から`timeout`で打ち切る短時間実行を先に行った。MODログ（`th12_autoplay.log`）から
以下を確認:

| 項目 | 結果 |
| --- | --- |
| ウィンドウ検出（最小化バグ対策） | 成功（`WaitForStableWindow: window appeared`後1030msで安定、ハングなし） |
| 入力注入 | 成功（`GetDeviceState`フックが56.8〜60.1Hzで安定してポーリングされることを`FpsMonitor`ログで確認） |
| メニュー自動操作 | 成功（タイトルロゴ待ち6000ms → Down×2 → Enter → Right → Enter → Enterの全ステップが「sequence complete」まで完了） |
| score_monitor | 成功（`ScoreMonitor: score=0 stage=0`から開始し、リプレイ再生開始後にscore/stage/lives/grazeが単調増加） |

## フル尺録画（`th12_02.rpy`、ReimuB / Hard / Stage All Clear、6面通し）

```bash
cd worker
timeout --kill-after=30s 2700s python3 record_th12.py \
  --replay-path games/th12/replay/th12_02.rpy \
  --output /tmp/th12_full.mp4 \
  --expected-score 183240710 \
  --desync-result-path /tmp/th12_desync_result.json \
  --timeout-result-path /tmp/th12_timeout_result.json
```

| 項目 | 結果 |
| --- | --- |
| VsyncPatch注入 | 成功（`extra_dlls=("vpatch_th12.dll",)`経由、`instances/th12-recording/vpatch_th12.dll`の配置を確認） |
| 終了検知 | 成功（画面静止検知、`still=8`連続で自然終了を検知。`still_detect_exclude_rect=(48, 214, 203, 430)`によりPause Menu明滅の誤検知なし） |
| 録画尺 | 1734.7秒（≒28.9分、**1回目の試行で成功、リトライなし**） |
| 重複フレーム率（録画開始15秒以降） | 0.1%（閾値30.0%を十分下回る） |
| A/V同期補正 | 成功（delta=-0.041s、`-itsoffset`で補正） |
| スコア完全一致検証 | **一致**（記録スコア183,240,710と、再生中に到達したサンプルが一致。`desyncDetected: false`） |
| タイムアウト打ち切り | なし（`timedOut: false`） |
| 出力 | 640x480 h264/aac 60fps、1,173,823,604バイト、1733.0秒 |

### 目視確認

出力動画のt=60s・900s・1700s付近のフレームを抽出して確認した。t=60sは1面の敵編隊・
弾幕、t=900sは村紗水蜜のスペルカード「溺符「シシガブルヴォーテックス」」、t=1700sは
6面ラストスペル「飛鉢「伝説の飛空円盤」」（聖白蓮）が正しく描画されていた。文字化け・
描画崩れは無く、画面右下の「東方星蓮船 Undefined Fantastic Object」ロゴ・60fps表示・
スコア/残機/グレイズ表示も正常だった。

## 理論尺との比較（touhou-recorder reports/67の指標）

`th12_02.rpy`のframeCountは102,326フレーム（≒1705.4秒、60fps基準）。実測プレイ時間
（総録画時間1734.7秒からメニュー操作・終了検知待ち約16秒相当を差し引いた概算）は
理論値に対しておおむね+1〜2%の範囲に収まっており、touhou-recorder reports/67の
c7i.xlarge実測（+2.11%）と近い水準だった。このローカル開発機はc7i.xlarge以上の性能を
持つため、この結果はth12の録画パイプライン自体に不具合が無いことの追加の裏付けになる
（推奨インスタンスタイプc7i.2xlargeの選定自体はtouhou-recorder reports/67の実機検証に
基づく、`worker/docs/titles/th12.md`参照）。

## 検証後の後片付け

出力動画（`/tmp/th12_full.mp4`）・デシンク/タイムアウト結果JSON・フレーム抽出画像は
一時ファイルのため削除した。検証完了後、`sudo systemctl start sattori-home-worker`で
自宅ワーカーを再開し、残存するwine/ffmpegプロセスが無いことを確認した。

## 考察・既知の限界

- 本検証はローカル単体実行（`--pulse-sink`未指定・タイトル資産はS3経由ではなくローカル
  コピー）であり、AWS EC2 Fleet実機・自宅ワーカー経由のE2E（アップロード→録画→
  CloudFront DL）・タイトル資産のS3アップロードは別途必要（Issue #76の完了条件、
  今回のスコープ外）。EC2上でのth12録画自体はtouhou-recorder reports/65〜67で
  c7i.2xlarge実機検証済み。
- Extraステージ（`th12_01.rpy`）・スコア表示オーバーフローバグ（VsyncPatch有無比較）の
  再検証はtouhou-recorder reports/62・64で既に実機確認済みのため、sattori本体コードでの
  再検証は本フェーズでは行っていない（通常ステージと同一のコードパスのため）。
- ウィンドウ最小化バグへの対策（`GameConfig.force_window_map`）は本検証のth12でのみ
  実機確認済み。他タイトルでは既定`False`のまま副作用が無いことをユニットテスト
  （`worker/tests/test_recording_window.py`）で担保している。
