# 孤児インスタンスの検知（`orphanInstances.ts` / `handlers/sweepOrphanInstances.ts`, Issue #23）

ジョブのどの状態遷移とも紐づかないまま課金され続ける EC2 インスタンスを拾う3段構えの対策と、
同じ Lambda に相乗りしている GPU vCPU 容量リースのリコンサイラの参照仕様。判定条件や走査の
起点を変える前に読むこと。[`apps/api/README.md`](../README.md) §5 から分けた。

**孤児 = ジョブのどの状態遷移とも紐づかないまま課金され続けるEC2インスタンス。**
対策は3段構えで、後段ほど「前段のハンドラ自体が失敗した場合」を拾う。

1. **窓を狭める**: `launch.ts` は `CreateFleet` の直後に `updateJobInstance()` を
   呼ぶ（`updateJobStatus`/`updateJobWorkerKind`より先）。
2. **後始末でタグからも引く**: `sfn/handleFailure.ts`・`admin/stopJob.ts` は
   `JobRecord.instanceId` だけでなく `findJobInstances()`（タグ`sattori:jobId`での
   `DescribeInstances`、GPUのフォールバック先も含む全ワーカーリージョン）の結果も
   terminate する。
3. **定期掃除**: `handlers/sweepOrphanInstances.ts` がEventBridgeのスケジュール
   （`ORPHAN_SWEEP_INTERVAL_MINUTES` = 10分間隔）で走る。**走査の起点はジョブ
   レコードではなくAWS上に実在するインスタンス**（`listTaggedInstances()`）。

判定は `orphanInstances.ts` にあり、猶予15分（`ORPHAN_INSTANCE_GRACE_MINUTES`）・
Step Functions実行の生死（`getExecutionLiveness()`）・実行中ジョブでは最新1台を保護、
と徹底して安全側に倒してある。最悪の孤児寿命は「猶予15分 + 掃除間隔10分」＝25分。

**同じLambda（`sweepOrphanInstances.ts`）にGPU vCPU容量リースのリコンサイラ
（Issue #270）が相乗りしている。** `gpuReconcile.ts`（判定ロジック）が実在する
GPUインスタンス（`listTaggedInstances()`の`instanceType`）とリース台帳
（`gpuSlots.ts`の`listGpuSlots()`）を突き合わせ、①期限切れ・孤児化したリースの
回収②`shrinkGpuLease()`失敗によるvCPUドリフトの補正③リースの無い生存インスタンスへの
補完リース作成（安全側=クオータ超過側に倒す）を行う。詳細は
[`0056`](../../../docs/decisions/0056-gpu-vcpu-lease-and-queue.md)。

> **判定を緩める・走査の起点を変える前に
> [`docs/decisions/0017`](../../../docs/decisions/0017-orphan-sweep-from-aws-instances.md)
> を読むこと**（各条件の根拠と、誤terminateがユーザーの録画をその場で殺す非対称性）。
