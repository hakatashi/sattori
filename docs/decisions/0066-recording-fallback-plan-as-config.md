# 0066. 録画速度・インスタンス・リージョンはタイトルごとの段の配列で決め、ユーザーに速度を選ばせない

- **状態**: 有効
- **決定日**: 2026-11-08
- **対象**: packages/shared / apps/api / home-worker / apps/web / infra
- **関連**: Issue #317、#315、#316、[`0010`](0010-slow-motion-no-worker-side-branching.md)・
  [`0056`](0056-gpu-vcpu-lease-and-queue.md)・[`0058`](0058-speedup-recording-on-gpu-instances.md)・
  [`0060`](0060-speedup-fallback-to-native-speed.md)・[`0061`](0061-gpu-capacity-fallback-to-eu-north-1.md)・
  [`0063`](0063-spot-capacity-shortage-is-permanent-within-a-job.md)・
  [`0064`](0064-cpu-slow-motion-and-g6-fallback-on-gpu-shortage.md)、
  [`2026-11-08-recommended-speed-fallback-order-and-cost.md`](../reports/2026-11-08-recommended-speed-fallback-order-and-cost.md)

録画の起動手段は、タイトルごとの**段の配列**（`packages/shared/src/recordingPlan.ts`の`RECORDING_PLANS`）を
先頭から試して決める。各段がリージョン・インスタンスタイプ・GPUの要否・録画速度を持つ。ユーザーは速度を
選ばない（選択UIを廃止）。**フォールバック先を変えるときは配列だけを書き換え、起動側に段やタイトルの分岐を
書かないこと。** 0058の「ユーザーが1〜4倍速を選ぶ」と、0060・0064の「`options.recordingSpeed`を一度だけ
書き換えて落とす」仕組みを置き換える。

## 背景

GPUの枯渇に合わせて、別リージョン（0061）・段の永続化（0063）・CPU低速と`g6.2xlarge`（0064）を継ぎ足した結果、
同じ判断が`requiresGpuRecording()`・`fallbackRecordingSpeedFor()`・`launchTiersFor()`・
`getCandidateInstanceTypes()`・`routingPolicyFor()`に分散し、`requestedRecordingSpeed`の「一度だけ落とす」状態と
絡み合っていた。段を1つ足すにも複数のファイルの分岐を直す必要があった。

また、ユーザーが選んだ速度はGPUが無いと実現せず、直近2週は倍速の21/23件が等倍に落ちていた（Issue #317）。
選択UIが、GPUの枯渇が続く現状に合っていなかった。

## 決定

- **段**: `RecordingStep`は`kind: "home"`（自宅ワーカーへのオファー）か`kind: "ec2"`（`platform`・`region`・
  `instanceTypes`・`speed`、任意で`speedByDifficulty`）。インスタンスタイプの候補リストも同じファイルへ移した。
- **経路**: Issue #317の時点では、速度選択UIの「おすすめ」を選んだときの経路をそのまま書き下した
  （上記レポート §1）。「品質が保たれる最速」へは変えていない。
- **ジョブの状態**: 使い切った段は従来どおり`capacityExhaustedTargets`へ記録し、意味を「このジョブで試さない段」へ
  広げた。次に試す段は「配列のうち記録が無く、管理設定でも除外されていない最初の段」
  （`currentRecordingStep()`）。段の`id`は既存の記録と互換（`gpu:eu-south-2`など）。
- **段を進める契機**（従来の3つのまま）:
  - Spot在庫の枯渇: `Launch`がその段を記録して同じ呼び出しの中で次の段へ（0063）。
  - GPU枠の30分待ち: `AcquireGpuSlot`がGPUの段をまとめて記録（`skippableGpuStepIds()`）。
  - クォータ超過などの3回目: `HandleFailure`が同上。
  - 自宅ワーカーの段は、claimされなくても記録しない（リトライのたびに再オファー）。
  - 全段を使い切ったら`capacity_exhausted`で失敗。「一度だけ落とす」特別扱いは無くなった。
- **速度は段が決まった時点で決める**: `Launch`は段ごとに`setRecordingStep()`で`options.recordingSpeed`と
  `recordingStepId`を書いてからワーカーの環境変数を作る。`POST /magic-links`は最初の段の速度を入れ、
  クライアントが送る`recordingSpeed`・`th06ncHighResolution`は拒否せず無視する（古いフロントエンドの
  キャッシュとの互換）。ワーカーへは従来どおり`FPS_LIMIT_TARGET_HZ`と`GPU_WORKER`だけ（0010）。`GPU_WORKER`は
  段の`platform`から決める（`WorkerEnvOptions.gpuWorker`）。
- **配列の制約**: GPUの段はGPU以外の段より前に置く（`AcquireGpuSlot`が最初の段についてだけGPUリースを確保し、
  `Launch`はGPU以外の段へ進むときに返却するため）。リージョンは一次リージョンか、GPUのフォールバック先
  （GPUのみ）。どちらも`recordingPlan.test.ts`で守る。
- **管理設定**: `skipFractionalGpuTiers`を`skipGpuSteps`（GPUの段をすべて除く）に改めた。旧名で保存された値も
  読む。`forceGpuFallbackRegion`は「一次リージョンのGPUの段を除く」として読み替えた。`AcquireGpuSlot`・`Launch`・
  `HandleFailure`が同じ判定（`apps/api/src/recordingSteps.ts`）を使う。
- **自宅ワーカー**: 段に`home`を持つタイトル（`HOME_WORKER_GAME_IDS`）だけを既定で引き受け、それ以外の明示指定を
  起動時に拒否する（0047の多層防御を段から導くようにした）。
- **表示**: ジョブページはフォールバックの案内をやめ、最終的な速度だけを出す。管理画面は`recordingStepId`と
  使い切った段を出す。旧レコードの`requestedRecordingSpeed`・`speedupFallbackReason`は型に残して読まない。

## 根拠

- 段の配列にすると、0061・0064のような追加は配列への1要素の追加で済む。
- 速度を段に持たせると、「同じ環境・タイトルなら同じ速度」がコードの構造から保証される。

## 採らなかった選択肢

- **段の状態を「現在の段の添字」で持つ**: 配列を書き換えたデプロイを跨ぐと、走っているジョブの添字が別の段を
  指してしまう。`id`の集合なら、配列の順や要素が変わっても意味が保たれる。
- **段をSFnのステートに展開する**: 段の追加がCDKの変更とデプロイ順の制約を伴うようになる。EC2の起動は実行時に
  SDKで行う方針（0002）にも反する。
- **品質が保たれる最速（Issue #317の当初案）**: 自宅ワーカーで録っていた等倍のジョブまで有料のGPUへ移り、GPU枠も
  混む。現行のおすすめの経路を変えずに、まず仕組みだけを移した。
- **リクエストの`recordingSpeed`を拒否する**: キャッシュされた古いフロントエンドからの録画が失敗する。

## 影響範囲

- `packages/shared/src/recordingPlan.ts`（段・候補・定数）、`cost.ts`（未記録時のサイズ帯）
- `apps/api/src/handlers/sfn/{launch,acquireGpuSlot,handleFailure}.ts`、`ec2.ts`（`launchTierFor()`・1段の起動）、
  `workerEnv.ts`、`workerRouting.ts`、`recordingSteps.ts`、`jobs.ts`（`setRecordingStep()`）、
  `handlers/requestMagicLink.ts`、`handlers/admin/retryJob.ts`
- `home-worker/src/config.ts`
- 段を変えたら、`docs/reports/`に経路と費用を残し、`cost.ts`の代表単価も見直すこと（AGENTS.md §3）。
