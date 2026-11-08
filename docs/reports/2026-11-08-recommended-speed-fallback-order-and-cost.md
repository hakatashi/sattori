# 「おすすめ速度」で録画したときのフォールバック順序と録画尺1時間あたりの費用

- **検証日**: 2026-11-08
- **対象**: 全12タイトルを「おすすめ」の録画速度で録画するときの、リージョン・インスタンスタイプ・録画速度の試行順序と費用
- **環境**: コードは `main`（`1758b0d`）。Spot価格は2026-11-08 07:42 UTC に `aws ec2 describe-spot-price-history`（`Linux/UNIX`）で取得した各AZの最新値
- **結論**: 最も安いのは2倍速のGPU（約$0.05〜0.08/時）、最も高いのはth06ncの最終段 `g6.2xlarge`（等倍で約$0.5/時）。ただし `g6f.2xlarge` のeu-south-2は今日もAZ間の価格差が大きく、`2c` が$0.53と突出している

おすすめ速度（`RECOMMENDED_RECORDING_SPEED`、`packages/shared/src/recordingSpeed.ts`）を選んだジョブが、
どの順で起動手段を試し、枯渇したらどの速度・どのインスタンスへ落ちるかをコードから読み取り、
その時点のSpot価格で**リプレイの尺1時間（等倍の3600秒）あたり**の録画費用を計算した。
フォールバックの根拠は [`decisions/0063`](../decisions/0063-spot-capacity-shortage-is-permanent-within-a-job.md)・
[`0064`](../decisions/0064-cpu-slow-motion-and-g6-fallback-on-gpu-shortage.md)。
**この記録は2026-11-08時点のスナップショット**で、Spot価格は日々動く。順序は `launchTiersFor()` を正とすること。

## 目次

- [1. おすすめ速度と試行順序](#1-おすすめ速度と試行順序)
- [2. 段ごとの詳細](#2-段ごとの詳細)
- [3. 速度を落とす契機](#3-速度を落とす契機)
- [4. Spot価格（2026-11-08 07:42 UTC）](#4-spot価格2026-11-08-0742-utc)
- [5. 費用の計算方法](#5-費用の計算方法)
- [6. 録画尺1時間あたりの録画費用](#6-録画尺1時間あたりの録画費用)
- [7. 既知の限界](#7-既知の限界)

## 1. おすすめ速度と試行順序

「GPU」はGPU系Launch Template・`worker-gpu`イメージ・`g6f.2xlarge`のこと。同じ段の中では、全サブネット（AZ）×
候補タイプを `price-capacity-optimized` で1回の `CreateFleet` に渡す。
以下は上から順に試し、**1台確保できた時点で終わり**。

| タイトル | おすすめ | 試行順序（1台確保できた時点で終了） |
| --- | --- | --- |
| th06・th06c・th08・th09・th10・th11・th12・th128 | 2倍速 | ①`g6f.2xlarge` eu-south-2 → ②`g6f.2xlarge` eu-north-1 → ③**等倍へ落とす**: 自宅ワーカー → ④CPU（下記）eu-south-2 |
| th07 | 3倍速 | 上と同じ（落とし先は等倍） |
| th15 | 2倍速 | ①`g6f.2xlarge` eu-south-2 → ②`g6f.2xlarge` eu-north-1 → ③**1/2倍速（Extraは1/3倍速）へ落とす**: `c7i.4xlarge` eu-south-2 |
| th20 | 等倍 | ①`g6f.2xlarge` eu-south-2 → ②`g6f.2xlarge` eu-north-1 → ③**1/2倍速へ落とす**: `c7i.4xlarge` eu-south-2 |
| th06nc（720p） | 2倍速 | ①`g6f.2xlarge` eu-south-2 → ②`g6f.2xlarge` eu-north-1 → ③`g6.2xlarge` eu-south-2（**速度は2倍速のまま**）→ 全滅なら `capacity_exhausted` で失敗 |
| th06nc（1080p） | 等倍 | 上と同じ（速度は等倍のまま） |

③のCPU（等倍へ落ちたとき）の内訳:

| タイトル | 自宅ワーカー | EC2 CPU の候補（eu-south-2、全AZ） |
| --- | --- | --- |
| th06・th06c・th07・th08・th09・th10 | 空いていれば先にオファー | `c7i.xlarge`・`c7a.xlarge`・`c7i-flex.xlarge`・`m7i.xlarge` |
| th11・th12・th128 | 同上 | `c7i.2xlarge`・`c7a.2xlarge`・`m7i.2xlarge` |

th15・th20の低速録画（`c7i.4xlarge`）は**自宅ワーカーへオファーしない**。th06nc・th15・th20のGPU段も同様
（`workerRouting.ts`、[`decisions/0047`](../decisions/0047-no-gpu-titles-for-home-worker.md)・`0064`）。

## 2. 段ごとの詳細

| 段ID（`capacityExhaustedTargets`） | リージョン | AZ | インスタンスタイプ | 条件 |
| --- | --- | --- | --- | --- |
| `gpu:eu-south-2` | eu-south-2 | 2a・2b・2c | `g6f.2xlarge`（L4の1/4、8vCPU） | GPUジョブすべて |
| `gpu:eu-north-1` | eu-north-1 | 1a・1b（`g6f`を提供するAZに限定） | `g6f.2xlarge` | GPUジョブすべて。出力バケットとタイトル資産はリージョン内のレプリカ（[`0061`](../decisions/0061-gpu-capacity-fallback-to-eu-north-1.md)・[`0062`](../decisions/0062-gpu-fallback-region-local-output-and-title-assets.md)） |
| `gpu-full:eu-south-2` | eu-south-2 | 2a・2b・2c | `g6.2xlarge`（L4フル） | **速度を落とせないGPUジョブ（th06ncのみ）** |
| `cpu:eu-south-2` | eu-south-2 | 2a・2b・2c | 上表のCPU候補、または低速録画の `c7i.4xlarge` | 非GPUジョブ（等倍へ落ちた後、低速録画） |

- 段の全サブネット×全候補が `InsufficientInstanceCapacity` などSpot在庫の枯渇で失敗したときだけ、その段を
  `capacityExhaustedTargets` に記録して次の段へ進む。記録した段は同じジョブのリトライで試さない（`0063`）。
- GPU段の候補は `g6f.2xlarge` 1タイプのみ。`g6f.xlarge`（4vCPU）は倍速録画が維持できないので外してある。
- 低速録画の候補が `c7i.4xlarge` 1タイプなのは、この構成で検証したのがそれだけだから（`0064`）。
- 全段が尽きたとき、`fallbackRecordingSpeedFor()` が速度を返すジョブは同じ `Launch` の中で速度を書き換えて
  割り当て直す。返さない（th06nc）ジョブはその場で失敗する。落とせるのは**一度だけ**（落とした後は
  GPUジョブではなくなる）。

## 3. 速度を落とす契機

速度を落とせるジョブ（th06nc以外）は、次の3つのどれかで落ちる。落とした後は
`options.recordingSpeed` が書き換わり、`AcquireGpuSlot`・GPUリース・GPUイメージを通らない。

| 契機 | 場所 | 条件 |
| --- | --- | --- |
| GPU段の全滅 | `handlers/sfn/launch.ts` | `gpu:eu-south-2`・`gpu:eu-north-1` が両方Spot枯渇（即座。待たない） |
| GPU枠の待ち行列 | `handlers/sfn/acquireGpuSlot.ts` | GPU vCPU枠を30分以上待った（`SPEEDUP_FALLBACK_QUEUE_WAIT_MINUTES`） |
| クォータ超過などの失敗 | `handlers/sfn/handleFailure.ts` | `VcpuLimitExceeded` 等で、3回目以降の試行（`SPEEDUP_FALLBACK_QUOTA_FAILURE_ATTEMPT`） |

落とす先（`fallbackRecordingSpeedFor()`）: th15・th20 → 1/2倍速（th15のExtraは1/3倍速、`replayInfo`が読めなければ1/2）、
他の倍速録画 → 等倍、th06nc → なし。th06ncは待ち行列でも落ちないので、待機の上限
（`GPU_QUEUE_MAX_WAIT_MINUTES`=120分）まで待つ。

## 4. Spot価格（2026-11-08 07:42 UTC）

USD/時間。各AZの最新値。

| インスタンスタイプ | リージョン | AZごとの価格 | 最安〜最高 |
| --- | --- | --- | --- |
| `g6f.2xlarge` | eu-south-2 | 2a $0.0612 / 2b $0.1103 / 2c $0.5283 | $0.0612〜0.5283 |
| `g6f.2xlarge` | eu-north-1 | 1a $0.0856 / 1b $0.1044 | $0.0856〜0.1044 |
| `g6.2xlarge` | eu-south-2 | 2a $0.4163 / 2b $0.4279 / 2c $0.4881 | $0.4163〜0.4881 |
| `c7i.xlarge` | eu-south-2 | 2a $0.0488 / 2b $0.0492 / 2c $0.0554 | $0.0488〜0.0554 |
| `c7a.xlarge` | eu-south-2 | 2a $0.0612 / 2b $0.0652 / 2c $0.0633 | $0.0612〜0.0652 |
| `c7i-flex.xlarge` | eu-south-2 | 2a $0.0292 / 2b $0.0302 / 2c $0.0295 | $0.0292〜0.0302 |
| `m7i.xlarge` | eu-south-2 | 2a $0.0317 / 2b $0.0279 / 2c $0.0265 | $0.0265〜0.0317 |
| `c7i.2xlarge` | eu-south-2 | 2a $0.0478 / 2b $0.0431 / 2c $0.0421 | $0.0421〜0.0478 |
| `c7a.2xlarge` | eu-south-2 | 2a $0.0459 / 2b $0.0489 / 2c $0.0503 | $0.0459〜0.0503 |
| `m7i.2xlarge` | eu-south-2 | 2a $0.0562 / 2b $0.0503 / 2c $0.1073 | $0.0503〜0.1073 |
| `c7i.4xlarge` | eu-south-2 | 2a $0.1003 / 2b $0.0863 / 2c $0.0820 | $0.0820〜0.1003 |

`g6f.2xlarge` のeu-south-2は2cだけ$0.53と突出している（`FALLBACK_SPOT_PRICE_USD_PER_HOUR` のコメントにある
9月の観測でも2cが高かった）。`price-capacity-optimized` は価格だけでなくキャパシティも見るので、
どのAZが選ばれるかは事前に決まらない。

## 5. 費用の計算方法

`packages/shared/src/recordingSpeed.ts` の `estimateRecordingCompletionSeconds()` と同じ式で、1台が
起動してから完了するまでの課金時間を出し、Spot単価と掛ける。

```
課金時間 = 固定オーバーヘッド180秒 + 録画の実時間 + 配信用変換（尺×変換比）
録画の実時間 = 等倍: 尺 / 倍速: 尺×1.05÷N / 低速: 尺×1.03÷速度
変換比       = GPU系 0.08 / CPU系 0.22
費用         = 課金時間 × (Spot単価 + EBS gp3 30GiB + パブリックIPv4)
EBS＋IPv4    = 30×$0.088/730 + $0.005 = 約$0.0086/時
```

尺3600秒のときの課金時間:

| 録画速度 | 録画の実時間 | 課金時間 | 課金時間（時） |
| --- | --- | --- | --- |
| 等倍（GPU） | 60.0分 | 67.8分 | 1.130 |
| 2倍速（GPU） | 31.5分 | 39.3分 | 0.655 |
| 3倍速（GPU） | 21.0分 | 28.8分 | 0.480 |
| 等倍（CPU） | 60.0分 | 76.2分 | 1.270 |
| 1/2倍速（CPU） | 123.6分 | 139.8分 | 2.330 |
| 1/3倍速（CPU） | 185.4分 | 201.6分 | 3.360 |

**含めていないもの**: S3・CloudFront・Lambda等（`MISC_USD_PER_JOB` で1ジョブ約$0.002）、eu-north-1の
ワーカーのリージョン間転送（出力とタイトル資産は同リージョン内のため小さい）、Spot中断・リトライの再実行分、
自宅ワーカーの電気代。

## 6. 録画尺1時間あたりの録画費用

USD。最安AZ〜最高AZのSpot単価で計算した範囲。**どの段で確保されるかで変わる**ので、最初に確保できる段（正常時）と、
落ちた先の段を分けて書く。

### 6.1 おすすめ速度で最初に確保できたとき

| タイトル | 速度 | 段 | 費用/尺1時間 |
| --- | --- | --- | --- |
| th06・th06c・th08・th09・th10・th11・th12・th128・th15・th06nc（720p） | 2倍速 | ①`g6f.2xlarge` eu-south-2 | $0.046（2a）〜$0.078（2b）。2cなら$0.352 |
| 同上 | 2倍速 | ②`g6f.2xlarge` eu-north-1 | $0.062（1a）〜$0.074（1b） |
| th07 | 3倍速 | ①`g6f.2xlarge` eu-south-2 | $0.034（2a）〜$0.057（2b）。2cなら$0.258 |
| th07 | 3倍速 | ②`g6f.2xlarge` eu-north-1 | $0.045（1a）〜$0.054（1b） |
| th20・th06nc（1080p） | 等倍 | ①`g6f.2xlarge` eu-south-2 | $0.079（2a）〜$0.134（2b）。2cなら$0.607 |
| th20・th06nc（1080p） | 等倍 | ②`g6f.2xlarge` eu-north-1 | $0.106（1a）〜$0.128（1b） |

### 6.2 GPUが全滅して落ちた先

| タイトル | 落ち先 | 費用/尺1時間 | 備考 |
| --- | --- | --- | --- |
| th06nc（720p・2倍速のまま） | ③`g6.2xlarge` eu-south-2 | $0.278〜$0.325 | 最も高い段。①②の約4〜5倍 |
| th06nc（1080p・等倍のまま） | ③`g6.2xlarge` eu-south-2 | $0.480〜$0.561 | 全タイトルで最大 |
| th06・th06c・th07・th08・th09・th10（等倍へ） | 自宅ワーカー | AWS上は$0 | 空いていれば。録画時間は尺と同じ約60分 |
| 同上 | ④CPU `.xlarge` | $0.045〜$0.094 | 最安は`m7i.xlarge`の2c、最高は`c7a.xlarge`の2b |
| th11・th12・th128（等倍へ） | 自宅ワーカー | AWS上は$0 | 同上 |
| 同上 | ④CPU `.2xlarge` | $0.064〜$0.147 | 上限は`m7i.2xlarge`の2c |
| th15（Extra以外、1/2倍速） | ③`c7i.4xlarge` | $0.211〜$0.254 | 録画の実時間が約2.1時間 |
| th15 Extra（1/3倍速） | ③`c7i.4xlarge` | $0.304〜$0.366 | 録画の実時間が約3.1時間 |
| th20（1/2倍速） | ③`c7i.4xlarge` | $0.211〜$0.254 | 同上 |

### 6.3 読み取れること

- 正常時の費用は、2倍速で尺1時間あたり約$0.05〜0.08（約8〜12円、$1=157円）。月1000回・平均30分尺でも
  録画費用は月$25程度に収まる計算になる。
- GPUが枯渇して等倍のCPUへ落ちても、自宅ワーカーが空いていれば$0、なくても$0.05〜0.15程度で、
  GPUの2倍速と同じオーダーに収まる。**費用面では「落ちる」ことよりも、待ち時間が約2倍になることのほうが影響が大きい**。
- th15・th20の低速録画は費用が正常時の約3〜5倍（約$0.2〜0.4）になり、**録画の実時間も2〜3倍**かかる。
- th06ncだけは、GPU枯渇時に費用が約4〜10倍（$0.28〜0.56）の `g6.2xlarge` へ落ちる。他に逃げ道がないため。
- 管理画面の推定（`cost.ts`）の代表単価（`g6f`=$0.08、`g6`=$0.40、`.4xlarge`=$0.118）は、今日の値と同オーダーで
  ずれていない（`g6f`は今日の最安AZでは$0.061、`.4xlarge`は$0.082〜0.100でやや低い）。

## 7. 既知の限界

- **Spot価格は取得時点の値**。時間帯で変わる。`g6f.2xlarge` のeu-south-2は9〜11月を通じてAZ間の差が大きい。
- どのAZ・タイプで確保されるかは `price-capacity-optimized` が決めるため、表の範囲のどこに落ちるかは予測できない。
  範囲は「全AZが確保できた場合の下限と上限」であって期待値ではない。
- **課金時間は推定式による概算**で、本番ジョブの実測ではない。固定オーバーヘッド180秒・変換比は
  2026-08〜09の本番ジョブからの近似（`COMPLETION_ESTIMATE`）。実際にはSpot中断・リトライが加算される。
- 尺1時間は理想化した値。**低速録画は録画の実時間が尺の2〜3倍になり、録画タイムアウトの実時間上限（120分、
  `MAX_WALL_CLOCK_TIMEOUT_SEC`）に当たる**。1/2倍速で尺60分は上限（約123.6分の見積もり）を超えるため、
  実際には尺約58分以上のリプレイは打ち切られる。1/3倍速は尺約39分で打ち切り（`0064`）。
  th15・th20の実リプレイはこれより短いので、表の1時間は比較のための換算値。
- `g6.2xlarge` の段は、本番ではLambdaからの起動が一度も確認できていない（在庫なし、
  [`2026-11-05-cpu-slow-motion-production-e2e.md`](2026-11-05-cpu-slow-motion-production-e2e.md)）。単価は今日の
  Spot価格履歴の値で、起動できる保証ではない。
- eu-north-1のG系Spotクォータは8vCPUで、同時1本が上限（[`2026-10-11-gpu-capacity-eu-south-2-vs-eu-north-1.md`](2026-10-11-gpu-capacity-eu-south-2-vs-eu-north-1.md)の時点）。
  今日のクォータは確認していない。
