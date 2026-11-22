# 0080. 640x480の残り9タイトルの録画の段をフレーム同期中心にする(th13のGPUの段は持たない)

- **状態**: 有効
- **決定日**: 2026-11-22
- **対象**: packages/shared / apps/web / docs
- **関連**: Issue #390、Epic #399、[`0078`](0078-frame-sync-plan-and-instance-type-verification-policy.md)・
  [`0079`](0079-home-worker-accepts-frame-sync-gpu-titles.md)・[`0070`](0070-th13-native-on-4xlarge-and-half-speed-on-2xlarge.md)・
  [`0066`](0066-recording-fallback-plan-as-config.md)、
  [`docs/reports/2026-11-22-th06-to-th13-frame-sync-ec2-verification.md`](../reports/2026-11-22-th06-to-th13-frame-sync-ec2-verification.md)

th06・th06c・th07・th08・th09・th10・th11・th128・th13の録画の段を、th12（[`0078`](0078-frame-sync-plan-and-instance-type-verification-policy.md)）と
同じ「自宅（フレーム同期）→ `.2xlarge`帯 → `c7i.4xlarge`（どちらもフレーム同期）→ GPU（実時間）」に切り替えた。残るのは
th20・th06nc（Issue #390の最後の項目）。

## 決定

- **段**（`recordingPlan.ts`の`frameSync640Plan()`）: `home`（フレーム同期）→ `cpu-fs-2xl:eu-south-2` → `cpu-fs-4xl:eu-south-2`
  → GPU（`gpu:eu-south-2`・`gpu:eu-north-1`、実時間）。GPUの速度は従来どおり、th07が3倍速、他が2倍速。
- **th13はGPUの段を持たない**。GPUの倍速が未検証（#374）で、Issue #390が「検証が終わるまでは外しておく」と定めたため。
  th13のEC2の等倍（`c7i.4xlarge`、Extraで落ち4.3%）・1/2倍速の段は、フレーム同期の段に置き換わった（[`0070`](0070-th13-native-on-4xlarge-and-half-speed-on-2xlarge.md)の段の構成を置き換える）。
- **`.2xlarge`帯が先**。実測の推定コストが9タイトルとも`.2xlarge`のほうが同じか安い（速度は`.4xlarge`が1.3〜1.6倍）。
- 段の`estimatedRealtimeFactor`は、EC2は実験ジョブの実測（上限解除後の平均速度を切り捨て）、自宅は#389の2並列の実測。
- **実時間専用の候補定数を削除**: `CPU_XLARGE_INSTANCE_TYPES`・`CPU_2XLARGE_INSTANCE_TYPES`・`TH13_NATIVE_INSTANCE_TYPES`・
  `TH13_SLOW_MOTION_INSTANCE_TYPES`と`speedupPlan()`・`HOME_NATIVE_STEP`。段の`id`のうち`cpu:eu-south-2`・`cpu-slow:eu-south-2`は
  th20・th06nc（`cpu:`のみ）を除いて使わなくなった。
- th06・th08の理論尺比は-13.2%・-11.4%だが、これは両タイトルのリプレイパーサー（frameCount）の過大見積もりによる（[`0077`](0077-worker-frame-sync-recording-path.md)。
  2xlarge/4xlargeで同値＝決定的、スコアは最終まで一致）。許容（-30%）の範囲内。

## 根拠

9タイトルを本番ジョブのリプレイ（通常ステージのフル尺）で、検証用イメージ（MOD焼き込み）により`c7i.2xlarge`・`c7i.4xlarge`で各1本録画し、
全本で三者照合・理論尺が許容内で完走した（[レポート](../reports/2026-11-22-th06-to-th13-frame-sync-ec2-verification.md)）。
フレーム同期はインスタンスタイプが品質に影響せず速度だけ変わるので、c7a・m7iの実測はしていない（[`0078`](0078-frame-sync-plan-and-instance-type-verification-policy.md)）。

## 採らなかった選択肢

- **th13のGPUの段を足す**: GPU倍速が未検証のため。#374で検証できたら足す。
- **`.4xlarge`帯を先にする**: 速いが、実測の推定コストが同じか高い。1280x960のth15だけは`.4xlarge`のほうが安い（[0078](0078-frame-sync-plan-and-instance-type-verification-policy.md)）。

## 影響範囲

`recordingPlan.ts`・`recordingPlan.test.ts`・`cost.test.ts`、`apps/api/docs/ec2-launch.md`、`docs/known-limitations.md`、`home-worker/README.md`、
`apps/web/src/data/changelog.ts`。**本番へ出すときは、タイトル資産（S3）のMODをフレーム同期対応のものに差し替えてから**
`pnpm run deploy`する（th12・th15は反映済み。他の9タイトルは2026-11-21時点のまま。`deploy-sattori`・`upload-title-assets` skill）。
