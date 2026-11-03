# Spotの容量不足をジョブ内の永続エラーとして扱う変更の本番検証

- **検証日**: 2026-11-04
- **対象**: PR #318（Issue #315）の、容量不足時の段の切り替え・等倍フォールバック・全段枯渇時の即時失敗・Launch Templateバージョンの削除
- **環境**: 本番AWS（eu-south-2、フォールバック先eu-north-1）。検証時はg6f.2xlarge Spotが両リージョンとも容量不足で、自宅ワーカーは停止中
- **結論**: 容量不足の経路はすべて設計どおりに動いた。GPUインスタンスの起動成功・自宅ワーカーへのオファー・Spot中断後のリトライは、この検証では通っていない

デプロイ直後に実ユーザーのth06ncジョブ2件が全段枯渇になったので、これを全段枯渇の実例として観察した。
等倍フォールバックは、検証ジョブを1本流して確かめた。

## 目的

PR #318の「デプロイ後に確認すること」を本番で確かめる。とくに、容量不足のときの`CreateFleet`の
`Errors`が使い切りと判定できる形か（PR作成時点では`InvalidParameterValue`のレスポンスでしか確認できていなかった）を見る。

## 方法

1. 05:36 UTCにPR #318をデプロイした（`LaunchFn`の更新は05:36:49）。
2. デプロイ後の`LaunchFn`のログ・`JobsTable`のレコード・Step Functionsの実行履歴・GPUリース（`GpuSlotsTable`）を確認した。
3. 検証ジョブを`verify-recording-in-production` skill §5の手順で1本流した。
   - リプレイ: `packages/replay-parser/test-fixtures/th08/th8_01.rpy`（スペルプラクティス、推定尺25秒）
   - オプション: `recordingSpeed: 2`、`watermark: true`
4. 完了後に動画をダウンロードし、`ffprobe`とフレームの目視で確認した。
5. 3つのLaunch Templateのバージョン一覧から、デプロイ後のバージョンが残っていないことを確認した。

## 結果

### 全段枯渇（実ユーザーのth06ncジョブ、2件）

| 時刻（UTC） | 出来事（1件目、`options.recordingSpeed: 1`） |
| --- | --- |
| 05:40:26.187 | ジョブ作成 |
| 05:40:40.580 | `gpuQueuedAt` |
| 05:40:42.817 | `launch_attempt`（`attempt: 1`） |
| 05:40:45.417 | `gpu:eu-south-2`が`capacityExhausted: true`（`UnfulfillableCapacity`×3） |
| 05:40:47.697 | `gpu:eu-north-1`が`capacityExhausted: true`（`UnfulfillableCapacity`×2） |
| 05:40:47.797 | `status: failed`、`errorCode: capacity_exhausted` |
| 05:43:50.589 | 実行が`FAILED`で終了（`WaitBeforeCheck`の3分後。リトライなし） |

- `capacityExhaustedTargets`は`gpu:eu-south-2`・`gpu:eu-north-1`の2件。
- 2件目（05:45:00に実行開始、`recordingSpeed: 2`）も同じ結果になった。GPU必須タイトルなので等倍へは落ちていない。
- 2件目の失敗後の`GpuSlotsTable`は`usedVcpu: 0`で、リースは残っていなかった。

### 等倍フォールバック（検証ジョブ1本）

| 時刻（UTC） | 出来事 |
| --- | --- |
| 05:44:07.913 | `gpuQueuedAt` |
| 05:44:09.394 | `launch_attempt`（`attempt: 1`） |
| 05:44:11.193 | `gpu:eu-south-2`が`capacityExhausted: true` |
| 05:44:13.093 | `gpu:eu-north-1`が`capacityExhausted: true` |
| 05:44:13.233 | `speedup_fallback`（`reason: gpu_capacity`、`from: 2`） |
| 05:44:15.913 | `launchedAt`（`c7i-flex.xlarge`、eu-south-2b、Spot） |
| 05:45:00 | ワーカーがジョブ開始（`gpuQueuedAt`から約52秒） |
| 05:46:12.042 | `status: done` |

- APIの応答は`requestedRecordingSpeed: 2`、`recordingSpeed: 1`、`timedOut: false`。
- 動画（`downloadUrl`、1回の取得で確認）: 640×480、60fps、29.23秒、h264・aac、17,907,925バイト。5秒目から40秒間の音量は平均-11.4 dB。
- 検証ジョブは`desyncDetected: true`になった（下記）。

### Launch Templateのバージョン

| テンプレート | 最新バージョンの作成時刻（UTC） | デプロイ後に試行した起動 |
| --- | --- | --- |
| CPU（eu-south-2） | 04:39:23（v250） | 検証ジョブ（起動成功） |
| GPU（eu-south-2） | 01:14:34（v912） | 3件（すべて容量不足） |
| GPU（eu-north-1） | 04:33:19（v443） | 3件（すべて容量不足） |

デプロイ後に作られたバージョンは、どのテンプレートにも残っていない。`LaunchFn`のログで`launch_template_version_delete_failed`は0件だった。

### 検証ジョブの`desyncDetected: true`

PR #318とは別の問題として調べ、[Issue #321](https://github.com/hakatashi/sattori-dev/issues/321)にした。

- 記録スコア15,068,010に対し、ScoreMonitorの最終観測値は940,580だった。
- 動画のスコア表示（約0.2秒間隔）は925,020 → 2,275,080 → 7,557,480 → 10,198,680で止まり、そのままリプレイ選択画面へ遷移した。
- 本番のth08の`done`ジョブを集計すると、スペルプラクティスは`true`が10件、`false`が0件、`null`が8件。通常プレイは`true`が4件、`false`が26件、`null`が13件だった。

## 考察・既知の限界

- **容量不足の`Errors`の形**: 全サブネットぶんの`UnfulfillableCapacity`が返り、使い切りと判定できた。観測したのは2026-11-04の3ジョブ・`g6f.2xlarge`のみで、CPUの候補タイプが容量不足になる場合は未確認。
- **通っていない経路**: GPUインスタンスの起動成功（eu-south-2・eu-north-1とも）、自宅ワーカーへのオファーとclaim、Spot中断後のリトライで使い切った段を飛ばす動作。バージョンを消したあとのテンプレートでGPUインスタンスが正しく起動することも、この検証では確かめていない。
- **実ユーザーへの影響**: 両リージョンの枯渇が続く間、GPU必須タイトルのジョブは失敗し続ける。ADR [`0063`](../decisions/0063-spot-capacity-shortage-is-permanent-within-a-job.md)のA案どおりの動作で、この2件はデプロイ後の約5分間に発生した。
- **デシンク判定**: 映像を目視した限りでは不自然な点はないが、表示は記録スコアへ届いておらず、誤判定とは断定できない（Issue #321）。過去ジョブのワーカーログは保持期間（14日）を過ぎており、スコアを照合できたのは検証ジョブの1件だけ。
- **検証ジョブのサンプル数**: 1本だけで、リプレイはスペルプラクティスの短いもの。録画品質の評価には使えない（重複フレーム率は評価していない）。
