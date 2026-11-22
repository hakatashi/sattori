# 0078. th12・th15の録画の段をフレーム同期中心にし、フレーム同期のインスタンスタイプは綿密に実機検証しない

- **状態**: 有効
- **決定日**: 2026-11-22
- **対象**: packages/shared / apps/api / apps/web / docs
- **関連**: Issue #390、Epic #399、[`0066`](0066-recording-fallback-plan-as-config.md)・
  [`0073`](0073-gpu-lease-for-next-ec2-step-and-capture-mode.md)・[`0077`](0077-worker-frame-sync-recording-path.md)・
  [`0042`](0042-2xlarge-instance-type-group-precedent.md)・[`0079`](0079-home-worker-accepts-frame-sync-gpu-titles.md)、
  touhou-recorder reports/104〜112、
  [`docs/reports/2026-11-22-th12-th15-frame-sync-ec2-verification.md`](../reports/2026-11-22-th12-th15-frame-sync-ec2-verification.md)

th12・th15の録画の段を、フレーム同期（CPU）中心の計画に切り替えた。あわせて、**フレーム同期の段のインスタンスタイプは
実機検証を簡略にする**運用にする。これを知らないと、フレーム同期の候補を足すたびに実時間方式と同じ綿密な検証を
やり直す、あるいは逆に実時間の段の検証まで省いてしまう。

## 決定

- **段**（`packages/shared/src/recordingPlan.ts`の`RECORDING_PLANS`）:
  - th12（640x480）: 自宅（フレーム同期）→ `.2xlarge`帯（c7i/c7a/m7i、フレーム同期）→ `c7i.4xlarge`（フレーム同期）→
    `g6f.2xlarge`（GPU・実時間2倍速。eu-south-2 → eu-north-1）
  - th15（1280x960）: 自宅（フレーム同期）→ `c7i.4xlarge`（フレーム同期）→ `.2xlarge`帯（フレーム同期。
    推定尺3300秒超は飛ばす）→ `g6f.2xlarge`（GPU・実時間1倍速）
  - 段の`id`は`home`・`cpu-fs-2xl:eu-south-2`・`cpu-fs-4xl:eu-south-2`・`gpu:*`。録画の上限（固定120分）・SFnの150分に
    当たる尺（`maxEstimatedDurationSeconds`の根拠）は Epic #399 の点検（本番631件で0件）による。
- **実機検証の方針**（ユーザー判断、2026-11-22）:
  - フレーム同期ではインスタンスタイプの違いは品質に影響せず、**速度にだけ影響する**。したがって新しいインスタンス
    タイプをフレーム同期の段へ足すときは、綿密な実機検証をしない。必要と思うときに簡単な速度検証だけする。
    `.2xlarge`帯の`c7i`/`c7a`/`m7i`と`c7i.4xlarge`は運用実績があり、検証は不要。
  - **新しい作品タイトルを足すときのクラウドでの実機検証は引き続き必須**。
  - **実時間（`realtime`）の段のインスタンスタイプは従来どおり実機検証が要る**（実時間方式は負荷が品質に出る）。
    `0042`の例外もそのまま実時間方式の話。
- **作品ごとのインスタンスタイプ候補の定数**（`TH13_NATIVE_INSTANCE_TYPES`・`TH13_SLOW_MOTION_INSTANCE_TYPES`など）は、
  全タイトルがフレーム同期へ移行したあとに削除する見込み（今は残す）。
- **ETA**: フレーム同期の段は倍率が無いので、段の`estimatedRealtimeFactor`（尺÷録画の実時間、実測値）を
  `GET /jobs/{id}`の`estimatedRealtimeFactor`として返し、進捗バーの録画フェーズの伸縮に使う
  （`apps/web/src/hooks/jobProgressBudget.ts`の`recordingScaleForJob()`、`estimateRecordingCompletionSeconds()`）。
  進捗の内挿はワーカーが報告する尺（動画のフレーム数）を基準にする。

## 根拠

- フレーム同期はMODがゲームの時計と音声を仮想化し、1フレームずつ書き出すので、取りこぼしが原理的に起きず
  負荷が高くても映像と音声が一致する（touhou-recorder reports/109、[`0077`](0077-worker-frame-sync-recording-path.md)）。
  開発者がローカルで全タイトルの録画を視聴確認済み。品質がインスタンスの性能で変わらない以上、検証すべきは速度だけ。
- th12・th15のEC2実機（実験ジョブ）での録画結果と速度は
  [`docs/reports/2026-11-22-th12-th15-frame-sync-ec2-verification.md`](../reports/2026-11-22-th12-th15-frame-sync-ec2-verification.md)。

## 採らなかった選択肢

- **フレーム同期でも`0042`のグループ（実時間方式での前例）を超えて、c7a・m7iを個別に実測して品質を確かめる**:
  品質が決定的で、確かめる対象が速度だけになるので、工数に見合わない（Issueの当初の記述はこの運用に更新した）。
- **th12の既存の実時間の段（`cpu:eu-south-2`等）を残す**: フレーム同期のほうが品質・コストとも優れ、
  実時間のCPU等倍はやめる計画（#391でCPU実時間専用のコードを削除する）。GPUの段だけ実時間で残す。

## 影響範囲

- `recordingPlan.ts`（`FRAME_SYNC_*_INSTANCE_TYPES`・`homeFrameSyncStep()`・`frameSyncCpuStep()`）と`recordingPlan.test.ts`。
- `apps/api/src/handlers/getJob.ts`・`packages/shared/src/api.ts`（`estimatedRealtimeFactor`）、フロントのETA。
- `AGENTS.md`§3、`.claude/skills/verify-recording-in-production`・`docs/runbooks/experiment-workflow.md`の方針の記述。
