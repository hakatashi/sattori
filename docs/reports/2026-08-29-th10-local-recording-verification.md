# th10（東方風神録）録画対応：sattori本体コードでのローカル実機検証

- **検証日**: 2026-08-29
- **対象**: th10（東方風神録）録画対応（Issue #75）。`worker/record_th10.py`・
  `recording_common.py`の拡張（絞り込みテンプレート照合・VsyncPatch ini動的書き換え）
- **環境**: ローカル開発機（HakataMatrix）、Wine + Xvfb + ffmpeg。ゲーム本体・WINEPREFIX・
  MODビルド成果物はtouhou-recorderの検証済みアセットをそのまま流用
- **結論**: sattori本体の録画パイプライン（touhou-recorderのPoCスクリプトではなく
  `worker/record_th10.py`）でth10のフル尺録画・終了検知・スコア完全一致検証・
  「バグマリ」修正オプション（`TH10_BUGFIX_MARISA_B`）のいずれも実機で成功を確認した。

touhou-recorderでのタイトル対応検証（reports/56〜60）を踏まえて実装したth10録画対応
（MOD移植・`recording_common.py`の終了検知一般化・VsyncPatch ini動的書き換え）を、
sattoriリポジトリ自身のコードで再検証したもの。

## 目的

Issue #75の実装（`worker/mods/th10_replay_autoplay/`・`worker/record_th10.py`・
`recording_common.py`の拡張・th10「バグマリ」修正オプション）が、touhou-recorderの
PoCスクリプトではなくsattori本体のコードで実際に動作することを確認する。

## 方法

touhou-recorderの`games/th10/`・`prefixes/th10-wined3d-gl/`をローカルの`worker/games/th10/`・
`worker/prefixes/th10-wined3d-gl/`へrsyncでコピーし（本番はS3タイトル資産アーカイブ経由、
`upload-title-assets` skill参照）、`worker/assets/replay_end_templates/th10.png`も配置した
上で、`worker/record_th10.py`をローカル単体実行した。

```bash
cd worker
python3 record_th10.py \
  --replay-path games/th10/replay/th10_07.rpy \
  --output /tmp/th10_07.mp4 \
  --expected-score 80202630 \
  --desync-result-path /tmp/desync_result.json
```

「バグマリ」修正オプションの検証には、ユーザー提供の検証用リプレイ`th10_p3_nopatch.rpy`
（`BugFixTh10Power3=0`で記録、touhou-recorder reports/56・58）を使い、`TH10_BUGFIX_MARISA_B`
環境変数を未設定（既定false、`RecordingOptions.th10BugfixMarisaB`の既定と同じ）のまま
フル尺録画した。あわせて、`TH10_BUGFIX_MARISA_B=1`時に`record_th10.py`の`build_config()`が
`vpatch_ini_overrides`へ正しく`("Option", "BugFixTh10Power3", "1")`を渡すことをPython単体で
確認した（`BugFixTh10Power3=1`で記録された`th10_p3_patch.rpy`側のフル尺録画は、
touhou-recorderのPoCスクリプトで4パターン全て実機確認済み・同一コードパスのため今回は
省略、reports/58）。

## 結果

### 通常リプレイ（`th10_07.rpy`、ReimuA / Hard、プラクティス6面）

| 項目 | 結果 |
| --- | --- |
| メニュー自動操作 | 成功（タイトルロゴ待ち6000ms・"PRESS ANY BUTTON"消し・Down×2→Replay→No.01選択の全ステップが touhou-recorder reports/56・59 と同じタイミングで完了） |
| VsyncPatch注入 | 成功（`extra_dlls=("vpatch_th10.dll",)`経由） |
| 終了検知 | 成功（絞り込み領域`(0,0)-(244,76)`・専用閾値25.0でのテンプレート照合、`end_template_consecutive`が2連続でMAD 5.66→8.84と閾値未満に到達） |
| 録画尺 | 383.2秒（1回目の試行は同一マシン上で稼働していた別の録画ジョブとのCPU競合により重複フレーム率48.7%で棄却・自動リトライ。2回目の試行で成功、下記参照） |
| 重複フレーム率（録画開始15秒以降） | 2.7%（閾値30.0%を十分下回る） |
| A/V同期補正 | 成功（delta=+0.276s、`-itsoffset`で補正） |
| スコア完全一致検証 | **一致**（記録スコア80,202,630と、再生中に到達したサンプルが一致。`desyncDetected: false`） |
| タイムアウト打ち切り | なし（`timedOut: false`） |
| 出力 | 640x480 h264/aac、309,444,991バイト、382.4秒 |

**1回目の試行の重複フレーム率48.7%について**: このマシンでは検証実施時、自宅ワーカー
デーモン（`sattori-home-worker.service`）が既に別の録画ジョブを稼働中だった。停止すると
稼働中の本番ジョブに実害が出るため停止せず、CPU競合を許容したまま検証を行った。
自動リトライ機構（`record_with_retry()`、既定3回）が正しく機能し、2回目の試行
（このときは競合が緩和されていた）で品質基準を満たす録画が得られた——**th10固有の
問題ではなく、このマシンの検証時の負荷状況によるもの**。

### 「バグマリ」修正オプション（`th10_p3_nopatch.rpy`、MarisaB / Hard、4面突入直後まで）

`TH10_BUGFIX_MARISA_B`未設定（既定false、`vpatch.ini`の`BugFixTh10Power3`を録画直前に
`0`へ書き換え）で、`BugFixTh10Power3=0`で記録されたリプレイを再生した。

| 項目 | 結果 |
| --- | --- |
| `vpatch.ini`書き換え | 成功（`apply_vpatch_ini_overrides()`が`[Option] BugFixTh10Power3 = 0`を書き込み） |
| 録画尺 | 425.6秒（1回目の試行で成功、リトライなし） |
| 重複フレーム率（録画開始15秒以降） | 0.2% |
| スコア完全一致検証 | **一致**（記録スコア59,677,770と、再生中に到達したサンプルが一致。`desyncDetected: false`） |
| タイムアウト打ち切り | なし（`timedOut: false`） |
| 出力 | 640x480 h264/aac、295,526,743バイト |

`TH10_BUGFIX_MARISA_B=1`時に`build_config()`が`vpatch_ini_overrides=(("Option",
"BugFixTh10Power3", "1"),)`を正しく返すことも別途Python単体で確認済み
（`worker/tests/test_recording_common.py`の`apply_vpatch_ini_overrides`系テストが
書き込み処理自体をカバーしている）。

## 考察・既知の限界

- 本検証はローカル単体実行（`--pulse-sink`未指定・タイトル資産はS3経由ではなくローカル
  コピー）であり、AWS EC2 Fleet実機・自宅ワーカー経由のE2E（アップロード→録画→
  CloudFront DL）は別途必要（Issue #75の完了条件）。EC2上でのth10録画自体は
  touhou-recorder reports/60で実機検証済み（c7i.xlarge、重複フレーム率2.3%以下）。
- 「バグマリ」修正オプションが誤った設定で使われた場合のデシンクは、本検証の対象外
  （touhou-recorder reports/58で確認済み、`docs/decisions/0036`参照）。
- 1回目の試行の重複フレーム率悪化はこのマシン固有の検証時条件によるもので、
  th10の録画品質そのものの評価には使えない（2回目の2.7%が実質的な基準値）。
