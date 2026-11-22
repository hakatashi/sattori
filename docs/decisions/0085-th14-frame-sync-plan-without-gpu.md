# 0085. th14の録画の段は、GPUの段を持たないフレーム同期の3段にする

- **状態**: 有効
- **決定日**: 2026-11-23
- **対象**: packages/shared / worker / docs
- **関連**: Issue #80、Epic #399、[`0078`](0078-frame-sync-plan-and-instance-type-verification-policy.md)・
  [`0081`](0081-frame-sync-plan-for-th20-and-th06nc.md)、touhou-recorder reports/103・110
  （`research/touhou-recorder/reports/`）、[`worker/docs/titles/th14.md`](../../worker/docs/titles/th14.md)

th14（1280x960）の計画は、自宅 → `cpu-fs-4xl` → `cpu-fs-2xl`（推定尺が長いと飛ばす）の**フレーム同期の3段のみ**。
GPUの段（`gpu:*`）は持たない。

## 決定

- `recordingPlan.ts`の`frameSync1280Plan(factors, { gpu: false })`で組み立てる。th15・th20と同じ形で、GPUの段だけ無い。
- 段の組み立ては配列だけを書き換えた（0066）。起動側にタイトルの分岐は無い。

## 根拠

- 1280x960のCPU描画は実時間の等倍で落ち4〜6%となり使えない（reports/103）が、フレーム同期なら落ちは原理的に起きず遅くなるだけ
  （ローカル16スレッドで1.17〜1.38倍速、reports/110）。
- GPUインスタンス（`g6f.2xlarge`）での2倍速は us-west-2 で検証済み（reports/103）だが、eu-south-2・eu-north-1ではSpot在庫の枯渇で
  sattori本体の環境では検証できていない。検証していない段は計画に入れない（Issue #80の依頼）。th13も同じ扱い（#374）。

## 採らなかった選択肢

- **th15・th20と同じくGPUの段を最後に置く**: 未検証の段を本番の計画に入れることになる。検証できたら配列に足すだけで済む。
- **実時間のCPU低速録画の段**: 廃止済み（0083）。

## 影響範囲

`recordingPlan.ts`・同テスト・`worker/docs/titles/th14.md`・`docs/known-limitations.md`。
段の`estimatedRealtimeFactor`（`TH14_FACTORS`）は実験ジョブの実測（[`docs/reports/2026-11-23-th14-frame-sync-ec2-verification.md`](../reports/2026-11-23-th14-frame-sync-ec2-verification.md)）。
自宅の値は実測せず、同じ1280x960のth15の値に揃えた。
