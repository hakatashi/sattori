# 0073. 録画の段に録画方式と推定尺の上限を足し、GPUリースは「次のEC2の段」で判定する

- **状態**: 有効
- **決定日**: 2026-11-21
- **対象**: packages/shared / apps/api
- **関連**: Issue #387、Epic #399、[`0056`](0056-gpu-vcpu-lease-and-queue.md)（リースを取る判定を改訂）・
  [`0063`](0063-spot-capacity-shortage-is-permanent-within-a-job.md)・
  [`0066`](0066-recording-fallback-plan-as-config.md)・[`0010`](0010-slow-motion-no-worker-side-branching.md)

Epic #399 の新しい録画計画は「自宅 → CPU（フレーム同期）×2 → GPU」で、**GPUの段が配列の最後に来る**。
今の`AcquireGpuSlot`・`Launch`は「GPUの段は先頭側にある」前提で、そのまま計画だけ書くとGPUの段でリースが無く
`Launch`が例外を投げる。そこで段の型とリース取得の判定を直した。**本番の挙動は変えない**（全タイトルの段は
今のまま、`captureMode: "realtime"`）。

## 背景

- `AcquireGpuSlot`は`currentRecordingStep()`（使い切っていない最初の段）がGPUのときだけリースを取る。
  自宅の段はclaimされなくても使い切り扱いにならない（0066）ので、自宅の段を持つタイトルでは常に`home`が返り、
  GPUの段が後ろにあるとリースが一度も取られない。
- `Launch`はGPUの段に入るとリースを読み直し、無ければ例外を投げる（0056）。
- 段に「録画方式」の概念が無く、`speed`が倍率として`FPS_LIMIT_TARGET_HZ`へ変換される。フレーム同期には倍率が無く、
  `FPS_LIMIT_TARGET_HZ`と併用できない。

## 決定

- **`captureMode: "realtime" | "frameSync"`を全段に持たせる**。型で`frameSync`は`speed: 1`固定
  （`StepCapture`）。`Launch`が`options.captureMode`へ`options.recordingSpeed`と同時に書き（`setRecordingStep()`）、
  `buildWorkerEnv()`が`frameSync`のとき`CAPTURE_MODE=frame_sync`を渡して`FPS_LIMIT_TARGET_HZ`は付けない。
  `realtime`では何も渡さない。**ワーカーにタイトル・倍率・割り当て先の分岐は作らない**（0010・0066）。
  `GET /jobs/{id}`にも`captureMode`を返す（フロントのETAは#390）。
- **段に`maxEstimatedDurationSeconds`・`estimatedRealtimeFactor`を任意で持たせる**。前者は、推定尺がそれを超える
  ジョブでその段を飛ばす保険（`remainingRecordingSteps()`が除外し、`Launch`が`capacityExhaustedTargets`へ記録して
  ログに残す）。後者はフロントのETA用の実測値（値は#390で入れる）。
- **GPUリースは「次のEC2の段」で判定する**（`nextEc2Step()`）。自宅の段を飛ばして最初のEC2の段がGPUなら
  `AcquireGpuSlot`がリースを確保・待機する。GPUの段が先頭でも最後でも動く。
- **GPUの段がCPUの段より後ろにあるとき**、CPUの段を`Launch`の中で使い切ってGPUの段に来ると、リースがまだ無い。
  `Launch`は起動せずに例外（「vCPUリースが見つかりません」）を投げ、既存の`HandleFailure`の通常のリトライ
  （`WaitBeforeCheck`3分・試行回数を1つ消費）で`AcquireGpuSlot`へ戻る。CPUの段は使い切りとして記録済みなので、
  戻った`AcquireGpuSlot`はGPUの段を次のEC2の段として待ち行列に入れる。待ち行列（FIFO・ETA・リース150分基準）、
  Spot枯渇の永続エラー（0063）は変わらない。
- **`skippableGpuStepIds()`は「最初のGPUの段より後ろにGPU以外の段が残っているとき」だけ**飛ばせるとする。
  GPUの段が最後なら、前にある自宅の段へ戻っても意味が無いので、待つ（待ち行列の上限120分で失敗）。
- **リースの返却**: GPUの段を試したあとGPU以外の段へ進むときの返却（`Launch`）は、GPUの段が最後の計画では
  実質発火せず、失敗時は`HandleFailure`、成功時は`ReleaseGpuSlot`が返却する。

## 根拠

実機・本番への影響は無い（挙動を変えない）。確認はユニットテスト（`recordingPlan.test.ts`の架空の計画、
`launch.test.ts`・`acquireGpuSlot.test.ts`・`handleFailure.test.ts`の「自宅 → CPU(frameSync)×2 → GPU」）。

## 採らなかった選択肢

- **Launchの内部でGPUの待ち行列に入る**: `Launch`は`waitForTaskToken`のLambdaで、待機ループをStep Functionsの
  外に持てない。0056が`Launch`の手前に独立ループを置いた理由と同じ。
- **リース確保を「GPUの段に入る直前」にLambdaの中でインラインで取る（待たずに、空いていれば取る）**:
  FIFOを守れず、先に待っているジョブを追い越す。CPUの段を使い切ったあとの1往復（約3分と試行1回）は、
  最後の砦であるGPUの段への到達としては許容できる。実測でこの遅延が問題なら再検討する。
- **リトライを試行回数に数えない**: CPUの段が使い切りにならなかった（クォータ超過など）のに`Launch`がGPUの段へ
  来た場合に、`AcquireGpuSlot`が次のEC2の段をCPUのままと見て無限に戻りうる。上限を保つため通常のリトライに
  任せた。
- **`speed`を`null`にして`frameSync`を表す**: 既存の`recordingSpeedForStep()`・コスト推定・フロントのETAが
  `speed`を数値として読むので、`speed: 1`固定の判別共用体にした。

## 影響範囲

`packages/shared/src/recordingPlan.ts`・`job.ts`・`api.ts`、`apps/api/src/handlers/sfn/{launch,acquireGpuSlot}.ts`・
`jobs.ts`・`workerEnv.ts`、管理画面のジョブ詳細。ワーカーが`CAPTURE_MODE`を読む実装は#389。段の値は#390で入れる。
