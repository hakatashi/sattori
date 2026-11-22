# 0081. th20・th06ncの録画の段もフレーム同期中心にする（Issue #390の最後。0047・0064・0067の実時間CPU段を置き換える）

- **状態**: 有効
- **決定日**: 2026-11-23
- **対象**: packages/shared / home-worker / apps/api(テスト) / apps/web / docs
- **関連**: Issue #390、Epic #399、[`0078`](0078-frame-sync-plan-and-instance-type-verification-policy.md)・
  [`0079`](0079-home-worker-accepts-frame-sync-gpu-titles.md)・[`0080`](0080-frame-sync-plan-for-640x480-titles.md)・
  [`0064`](0064-cpu-slow-motion-and-g6-fallback-on-gpu-shortage.md)・[`0067`](0067-th06nc-cpu-slow-motion-and-drop-1080p.md)・
  [`0066`](0066-recording-fallback-plan-as-config.md)、
  [`docs/reports/2026-11-23-th20-th06nc-frame-sync-ec2-verification.md`](../reports/2026-11-23-th20-th06nc-frame-sync-ec2-verification.md)

全13タイトルが「自宅（フレーム同期）→ EC2のフレーム同期（2帯）→ GPU（実時間、最後の段）」になった。

## 決定

- **th20**（1280x960）: th15と同じ形。`home` → `cpu-fs-4xl:eu-south-2` → `cpu-fs-2xl:eu-south-2`（推定尺3300秒超は飛ばす）→ `gpu:*`（実時間1倍速）。
- **th06nc**（720p）: 640x480と同じ形。`home` → `cpu-fs-2xl` → `cpu-fs-4xl` → `gpu:*`（実時間2倍速）。1080pは保留のまま。
- 計画の組み立ては`frameSyncLowResPlan()`（640x480・th06nc）と`frameSync1280Plan()`（th15・th20）の2つに集約した。
- **実時間のCPU低速録画の段（`cpu:eu-south-2`）を削除**し、`CPU_SLOW_MOTION_INSTANCE_TYPES`・`TH06NC_CPU_INSTANCE_TYPES`・`cpuStep()`も消した。
  これで0064（th20）・0067（th06nc）のCPU段と、`g6.2xlarge`の記述は歴史になった。
- **GPUの段が最後になった**。GPUの待ち行列の長時間待ち・クォータ超過で段を飛ばす処理（`skippableGpuStepIds`）は、全タイトルで
  「GPUの段より後ろにGPU以外の段が残る」ことが無くなったため、本物の計画では発動しない。仕組みは残してあり、テストは
  旧計画へ差し替えて確かめる（`apps/api/src/testSupport/frameSyncPlan.ts`）。
- **自宅の段**をth20・th06ncにも置いた（0079の方針。並列度は2のまま）。0047は0079で置き換え済み。
- 段の`estimatedRealtimeFactor`は実験ジョブの実測（レポート）。

## 根拠

本番ジョブのリプレイ（th20 Normal 1841秒、th06nc Normal 1519秒・Extra 958秒）を検証用イメージで`c7i.2xlarge`・`c7i.4xlarge`に各1本、
全6本が完走し、理論尺±0.6%以内・スコア一致・視聴問題なし。推定コストはth20が`.4xlarge`、th06ncが`.2xlarge`で安い。
th06ncのExtraで実時間方式に出ていた描画の間引き（0067）は、フレーム同期では速度が落ちるだけで画質に出ない。

## 採らなかった選択肢

- **th20・th06ncだけGPUを先頭に残す**: GPUはSpotの枯渇・クォータの待ちが起きうる。CPUのフレーム同期は品質が同じで、待たずに録れる。
- **th06ncの1080pをこの機に復活**: Issue #390が保留としたまま。

## 影響範囲

`recordingPlan.ts`・同テスト・`cost.test.ts`・`home-worker`のテスト・apiのテスト（旧計画への差し替え）、`apps/api/docs/ec2-launch.md`、
`docs/known-limitations*.md`、`home-worker/README.md`、changelog。**本番へ出すときは、タイトル資産（S3）のth20・th06ncのMODを
フレーム同期対応のものへ差し替えてから**`pnpm run deploy`する（`deploy-sattori`・`upload-title-assets` skill）。
