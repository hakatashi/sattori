# 0056. GPU録画ジョブのvCPU容量をDynamoDBでリースし、`Launch`の手前で待たせる

- **状態**: 有効
- **決定日**: 2026-09-19
- **対象**: apps/api / infra
- **関連**: Issue #270、`docs/decisions/0018-home-worker-pull-assignment.md`、
  `docs/decisions/0046-gpu-ec2-instance-and-fixed-ami.md`、
  `docs/decisions/0045-ec2-slow-motion-for-th20.md`

GPU描画必須タイトル（th06nc・th15）のvCPU容量を `GpuSlotsTable`（DynamoDB、
リース1件=1アイテム＋原子カウンタを`TransactWriteItems`で会計）でリースし、
Step Functionsの`Launch`の**手前**に`AcquireGpuSlot`/`WaitForGpuSlot`の枠取りループを
挟む。投入順は`JobsTable`のsparse GSIでFIFO保証し、死んだ待機者は心拍で自己修復する。
CPU系タイトルの挙動は一切変えない。

## 背景

eu-south-2のG系スポットインスタンスのvCPUクオータは現状**8vCPU**しかない
（`docs/decisions/0046`）。GPUジョブは`g6f.xlarge`(4vCPU)/`g6f.2xlarge`(8vCPU)で
起動するため同時1〜2本しか走れない。クオータの存在を前提にしていなかった既存の
割り当てロジックは、枠が埋まっている間に来た2本目を以下の形で壊していた:

1. **タイムアウトして失敗する。** `CreateFleet`のクオータ不足はStep Functionsの
   失敗リトライループ（`WaitBeforeCheck`3分×`MAX_ATTEMPTS`10回≒27分）で吸収される
   が、1ジョブの完了には15〜30分かかるので待ちきれず`errorCode: "retries_exhausted"`
   で失敗する。
2. **待ち行列が可視化されない。** UI文言（`jobProgress.status.queued`）だけが
   「録画の順番を待っています」と先行しており、`queued`は実際には`StartExecution`
   直後の通過点でしかなかった。
3. **投入順が録画順に反映されない。** 誰が先に枠を取るかは`CreateFleet`の運次第。

クオータ引き上げ申請はAWSサポートから1週間以上応答が無く、望みは薄い。

## 決定

### 中核: `Launch`の手前の独立した枠取りループ

```
AcquireGpuSlot (LambdaInvoke, 通常invoke, resultPath:"$.slot")
  → Choice "GpuSlotAcquired?"
      ├ acquired=true  → Launch (既存、waitForTaskToken)
      │                     ├ 成功 → ReleaseGpuSlot → Succeed(JobSucceeded)
      │                     └ Catch → WaitBeforeCheck(3分) → HandleFailure
      │                                → ShouldRetry?
      │                                    ├ true  → IncrementAttempt → **AcquireGpuSlot**
      │                                    └ false → Fail(JobFailed)
      ├ acquired=false, timedOut=false → WaitForGpuSlot (Wait, SecondsPath) → AcquireGpuSlot
      └ timedOut=true   → Fail(GpuQueueTimeout)
```

- **成功パスに`ReleaseGpuSlot`を挟む**（`Launch`成功後、`Succeed`の手前）。実装レビューで
  最初の設計案にこれが抜けていることが判明した——無いと正常完了してもリースが
  `GPU_LEASE_ACTIVE_MINUTES`(180分)解放されず2本目が実質走らなくなる致命的な穴だった。
- **リトライ時は`Launch`ではなく`AcquireGpuSlot`へ戻る**。`HandleFailure`が既にリースを
  返却しているため、`Launch`へ直接戻ると無リースで`CreateFleet`してしまう。
  **さらにリトライ時（`attempt > 1`）は4vCPUでの投機的確保を行わず、クオータ全量（8vCPU）の
  回復を待つ**。先行ジョブが`g6f.xlarge`（4vCPU）で走っている間に2本目が4vCPUで起動を
  試み、`g6f.xlarge`のスポット在庫枯渇で失敗した場合、4vCPUのまま再試行を繰り返すと
  `MAX_ATTEMPTS`（10回≒27分）を浪費して先行ジョブの完了（8vCPU回復で`g6f.2xlarge`が
  使えるようになる）を待たずに`retries_exhausted`で死んでしまう逆転現象を防ぐため。
- **待機はリトライ回数（`attempt`）を消費しない。** これが「30分でタイムアウト」問題の
  根本解決——`retryPolicy.ts`の`MAX_ATTEMPTS`は「起動を試みて失敗した回数」だけを
  数える本来の意味に戻る。
- 非GPUジョブは`AcquireGpuSlot`が`requiresGpuRecording(job.game)`で判定して
  **DynamoDBに一切書き込まず**即`{acquired: true}`を返す。

実装: `infra/lib/sattori-stack.ts`（ステートマシン定義）、
`apps/api/src/handlers/sfn/acquireGpuSlot.ts`・`releaseGpuSlot.ts`。

### GPU vCPU会計: `GpuSlotsTable`（リース1件=1アイテム＋`TransactWriteItems`）

PK=`slotKey`（定数`"gpu"`）、SK=`itemKey`。カウンタアイテム（`itemKey="#quota"`、
`usedVcpu`）とリースアイテム（`itemKey="job#<jobId>"`）が同一パーティションに同居し、
`Query(slotKey="gpu", ConsistentRead: true)`1回で台帳全体を強一貫で読める。

確保・縮小・返却はすべて`TransactWriteItems`で、リースアイテムの`Put`/`Update`/`Delete`と
カウンタの`Update`を1トランザクションにまとめる。`ConditionExpression`
（`usedVcpu <= GPU_VCPU_QUOTA - reserve`等）が「クオータ超過禁止」を直接表現するため、
事前の空き容量チェックと実際の書き込みの間に競合が起きても過剰確保は起きない。

実装: `apps/api/src/gpuSlots.ts`。

### FIFO順序: `JobsTable`のsparse GSI `GpuQueueIndex`

`HomeWorkerOfferIndex`（`docs/decisions/0018`）と同じパターン。`gpuQueuedAt`
（FIFO順の基準、1回だけセット）と`gpuQueueEnteredAt`（タイムアウト判定の起点、
待機エピソードごとにリセット）を意図的に分離し、リトライで再度待機列に入っても
即座にタイムアウトしないようにする。死んだ待機者（管理画面の緊急停止・Lambdaクラッシュ
等で`gpuQueueState`が取り残されたもの）は`gpuQueueHeartbeatAt`の陳腐化で自己修復する
（head-of-line blocking対策）。

実装（PR2、本ADRと同時に設計、実装は順次マージ）: `apps/api/src/gpuQueue.ts`。

### 実装段階（PR1〜PR3）

| # | 内容 |
| --- | --- |
| PR1 | GPU vCPU容量リース（本ADRの中核、FIFO順序なし＝早い者勝ち） |
| PR2 | FIFO順序・head-of-line blocking対策 |
| PR3 | ジョブページへの待ち順位・推定待ち時間の表示 |

## 根拠

- eu-south-2のG系スポットクオータ8vCPUの実測は`docs/decisions/0046`・
  `docs/known-limitations.md`§1・§7。
- Step Functions Standard実行の履歴イベント上限（25,000件）を踏まえ、待機間隔は
  経過時間に応じてアダプティブに間伸びさせる（`apps/api/src/gpuQueue.ts`の
  `nextPollIntervalSeconds()`、`gpuQueue.test.ts`で120分フル待機×10リトライでも
  上限に収まることを回帰テストしている）。
- `TransactWriteItems`にはCDKの`Table.grantReadWriteData()`が対応していない
  （`WRITE_DATA_ACTIONS`に`dynamodb:TransactWriteItems`が含まれない。CDK
  `aws-dynamodb/lib/perms.js`で確認）ため、`Table.grant(fn, "dynamodb:TransactWriteItems")`
  を個別に付与する必要がある。

## 採らなかった選択肢

- **SQS等の別キューを立てる。** `docs/decisions/0018`が既に却下している
  （`waitForTaskToken`のtaskToken契約の共通性が崩れる）。今回もEC2/自宅ワーカーで
  共通のtaskToken契約は変更しない。
- **単一アイテム＋`version`楽観ロックでのvCPU会計。** 「合計vCPUを読んでから書く」
  方式はリースごとの期限管理・リコンサイルが1アイテム内のマップの部分更新になり
  煩雑。1件=1アイテムなら`ConditionExpression`自体が「クオータ超過禁止」を直接
  表現でき、期限切れ回収・リコンサイラも通常の`Query`+条件付き更新で素直に書ける。
- **`JobsTable`の擬似アイテムやSettingsTableへの同居。** `apps/api/src/adminCosts.ts`が
  `JobsTable`を全件`Scan`して全アイテムをコスト集計にキャストしており、擬似
  アイテムが紛れ込む。`SettingsTable`はPKが`settingKey`単独で「1件=1アイテム」
  構成が取れず、管理UIの設定編集という別のセマンティクスとも衝突する。
- **既存リトライループの`MAX_ATTEMPTS`を増やすだけ。** 枠が空いたことを検知できず
  3分間隔で盲打ちし続ける。投入順も保証されない。
- **`g6f.2xlarge`単独固定で枠を1本に固定。** `docs/decisions/0046`が既に「2台分の
  並列運用余地を残す」理由でこの案を却下している。
- **Service Quotas APIでクオータを動的取得。** `docs/decisions/0045`の「設定値は
  ランタイムの外部ストアでなくコード内定数」という流儀に反する。`GPU_VCPU_QUOTA`は
  `packages/shared/src/gpuQueue.ts`のコード内定数として持ち、引き上げが通ったら
  そこを書き換えてデプロイする。
- **`requiresGpu`を`StartExecution`のinput（`{jobId, attempt}`）に足し、
  ステートマシンの`Choice`だけで分岐する。** デプロイ中に飛行中の実行（旧input）が
  新しい`Choice`条件で判定できず落ちる懸念があり、Lambda（`AcquireGpuSlot`）側で
  `requiresGpuRecording(job.game)`を毎回判定する方が安全（デプロイ間の互換性を
  ステートマシン定義側で担保しなくてよい）。
- **`docs/decisions/0018`が却下した「オファー待ちをWaitステートで表現する」案との
  違い。** あちらは`Launch`の`waitForTaskToken`区間**内**でのオファー待ち（自宅
  ワーカーのclaim待ち、既定20秒）を対象にしており、却下理由は「`waitForTaskToken`
  契約が複雑になる／待機20秒程度ならLambdaの実行時間で払うほうが単純」。今回の
  `AcquireGpuSlot`/`WaitForGpuSlot`は`Launch`の**外側**の独立したループで、
  `waitForTaskToken`契約には一切触れない。待機も数十分〜120分オーダーで、Lambdaの
  実行時間（`LAUNCH_LAMBDA_TIMEOUT_SECONDS`=60秒）では原理的に表現できない規模。

## 影響範囲

- `infra/lib/sattori-stack.ts`のステートマシン定義（`RecordingStateMachine`）を
  変更する場合は、`AcquireGpuSlot`→`Launch`→`ReleaseGpuSlot`の結線と、
  `ShouldRetry?`の遷移先が`AcquireGpuSlot`であることを崩さないこと
  （`infra/test/sattori-stack.test.ts`の「GPU vCPU容量リースのキューイング」
  describeブロックで回帰テストしている）。
- `apps/api/src/handlers/admin/retryJob.ts`の`buildRetryJob()`は、新しいジョブレコードに
  GPUキュー関連フィールド（`gpuQueueState`等）を引き継がない除外リストを持つ
  （PR2）。フィールドを追加する際はここも更新すること。
- `apps/api/src/ec2.ts`の`getCandidateInstanceTypes()`にGPU候補タイプを追加する場合、
  `packages/shared/src/gpuQueue.ts`の`GPU_INSTANCE_TYPE_VCPUS`にもvCPU数を追加すること
  （`reservableVcpu()`・`vcpusForInstanceType()`の対応表）。
- `GpuSlotsTable`へ書き込むLambdaを追加・変更する場合、`Table.grantReadWriteData()`
  だけでは`dynamodb:TransactWriteItems`が付与されないことを忘れないこと
  （上記「根拠」参照）。
