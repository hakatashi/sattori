# 0031. 非終端のまま固まったジョブは、ジョブレコードのstatusを起点に定期掃除する

- **状態**: 有効
- **決定日**: 2026-08-26
- **対象**: apps/api / packages/shared / infra
- **関連**: Issue #132、Issue #23（`0017`）

`queued`/`launching`/`recording`/`converting`で固まったジョブレコードを、既存の
`OrphanInstanceSweepRule`（10分間隔）に相乗りする新しいLambda
（`handlers/sweepStalledJobs.ts`）が拾い、Step Functions実行が生きていなければ
`failed`へ確定する。追加インフラ（新規Rule・新規GSI）は無し。

## 背景

Issue #132で洗い出したとおり、ジョブが非終端状態のまま永久に固まる経路が複数ある
（`startJob.ts`の`StartExecution`前にLambdaが死ぬ、`HandleFailureCrashed`へ倒れた実行、
管理画面の緊急停止でterminateが失敗、等）。孤児EC2は`0017`の掃除役が拾うので課金は
止まるが、**ジョブレコード側には掃除役が存在せず**、フロントは`isTerminalStatus`に
なるまで無期限にポーリングし続ける（上限も「時間がかかりすぎています」の表示も無い）。

個々の経路を1つずつ塞いでも「そのハンドラ自体が失敗した場合」が必ず残る
（`0017`のオーファンEC2掃除がAWS実インスタンス起点にした理由と同じ構造の問題）。

## 決定

- `handlers/sweepStalledJobs.ts`が`StatusCreatedAtIndex`（GSI、`apps/api/src/adminJobs.ts`
  と共用）を`queued`/`launching`/`recording`/`converting`の4status分Queryし、
  `JobRecord.updatedAt`が`STALLED_JOB_THRESHOLD_MINUTES`（180分、
  `packages/shared/src/worker.ts`）以上前で、かつ`getExecutionLiveness()`が
  `running`を返さないジョブを`failed`に確定する（`unlessDone: true`で`done`を上書きしない
  ガードは`handleFailure.ts`・`admin/stopJob.ts`と同じ）。
- 判定の純粋ロジックは`stalledJobs.ts`の`isStalledJob()`に切り出し、`pending`は
  対象から明示的に除外する（マジックリンク未クリックのまま最大24時間残るのが正常な
  状態で、ここに巻き込むと未クリックのジョブを誤って`failed`にしてしまう）。
- 判定の主たる根拠は`0017`と同じく**statusではなくStep Functions実行の生死**にする
  （`updatedAt`はあくまで「無駄なDescribeExecution呼び出しを減らす」ための足切り。
  実行がrunningである限り、リトライで実際の所要時間が180分を超えても対象にしない）。
- 経路(a)（`startJob.ts`の`StartExecution`前にLambdaが死ぬケース）はこの掃除役の
  10分間隔を待たせず即時に救済できるため、別途`startJob.ts`側にも対策を入れた:
  2回目以降のアクセスで`status === "queued"`かつ実行が`absent`なら、
  `StartExecutionCommand`だけを冪等に張り直す（実行名にjobIdをそのまま使っているため）。

## 根拠

- **追加インフラが不要**。`StatusCreatedAtIndex`はIssue #51（管理画面のジョブ一覧）で
  既に存在し、`getExecutionLiveness()`も`0017`で確立済みの判定手段のため、新しいGSIも
  新しいEventBridge Ruleも要らない。既存Ruleへターゲットを1つ追加するだけで済む。
- **誤判定の代償が孤児EC2掃除より小さい**。この掃除役は`failed`へ倒すだけで
  `TerminateInstances`のような破壊的操作を伴わない（生きた録画があっても、実行が
  `running`である限り一切手を出さないので、そもそも誤ってジョブを潰すことがない）。
  そのため`0017`ほど神経質な猶予チューニングは要らず、180分（taskTimeout150分+30分）
  という単純な値で十分。
- **`pending`を除外しないと壊れる**。`pending`も`isTerminalStatus()`的には非終端だが、
  Step Functions実行が最初から存在しないのが正常な状態（マジックリンク未クリック、
  最大24時間）。ここを対象に含めると、単にリンクを開いていないだけの大量のジョブを
  誤って`failed`にしてしまう。

## 採らなかった選択肢

- **`updatedAt`だけで判定する（実行の生死を見ない）**。Step Functionsのリトライ
  （最大10回、`retryPolicy.ts`の`MAX_ATTEMPTS`）で実際の所要時間が180分を超えることは
  正常にあるため、`updatedAt`のみで倒すと生きているリトライ中のジョブを誤って
  `failed`にしてしまう（`0017`が`status`だけで孤児判定しないのと同じ理由）。
- **`sweepOrphanInstances.ts`に統合する**。走査の起点（AWS実インスタンス vs
  ジョブレコードのstatus）が異なり、後始末の性質（terminateという破壊的操作 vs
  ジョブレコードの`failed`確定）も異なるため、同じ関数に混ぜるとテストの見通しが
  悪くなる。スケジュール（EventBridge Rule）だけ共有し、Lambda・IAMロール・
  テストファイルは分けた。
- **専用のEventBridge Ruleを新規に作る**。掃除の性質・許容される検知遅延
  （数分〜数十分オーダー）が孤児EC2掃除と同等なため、Rule自体を増やす理由が無い。

## 影響範囲

- `apps/api/src/stalledJobs.ts` / `src/handlers/sweepStalledJobs.ts`
- `apps/api/src/handlers/startJob.ts`（経路(a)の即時救済）
- `packages/shared/src/worker.ts`（`STALLED_JOB_THRESHOLD_MINUTES`）
- `infra/lib/sattori-stack.ts`（`OrphanInstanceSweepRule`のターゲット追加、
  `StartJobFn`への`states:DescribeExecution`権限追加）
- `apps/web/src/i18n/locales/{ja,en}/translation.json`（`errors.stalled`）
