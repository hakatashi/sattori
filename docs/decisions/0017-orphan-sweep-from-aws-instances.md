# 0017. 孤児インスタンスの掃除はジョブレコードではなく AWS 上の実インスタンスを起点に走査する

- **状態**: 有効
- **決定日**: 2026-08
- **対象**: apps/api
- **関連**: Issue #23、PR #107

**孤児 = ジョブのどの状態遷移とも紐づかないまま課金され続ける EC2 インスタンス。**
定期掃除（`sweepOrphanInstances.ts`）の走査は `JobsTable` の列挙ではなく、
**タグ `sattori:jobId` を持つ実インスタンスの列挙**から始める。レコードに痕跡が無い
孤児こそが最も拾いたい対象だからである。判定は徹底して安全側に倒してある。

## 背景

`sfn/launch.ts` は EC2 Fleet の起動（＝課金開始）と `instanceId` の DynamoDB への
永続化が別ステップに分かれているため、その間に Lambda がタイムアウトすると
`JobRecord.instanceId` が空のまま起動済みのインスタンスだけが残る。この窓は
**原理的に消せない**（起動と記録を1つの原子的操作にすることはできない。
[`0002`](0002-ec2-launch-at-runtime-not-iac.md) の副作用）。

同じ結末になる経路は他にもある（`HandleFailureCrashed` へ倒れた実行、緊急停止時の
terminate 失敗など）。放置すると 1 台あたり最大 150 分（タスクタイムアウト）課金され続ける。

## 決定

対策は3段構えで、**後段ほど「前段のハンドラ自体が失敗した場合」を拾う**。

1. **窓を狭める**: `launch.ts` は `CreateFleet` の直後に `updateJobInstance()` を
   呼ぶ（`updateJobStatus`/`updateJobWorkerKind`より先）。DynamoDB書き込み3回ぶんの
   窓が1回ぶんに縮む。
2. **後始末でタグからも引く**: `sfn/handleFailure.ts`・`admin/stopJob.ts` は
   `JobRecord.instanceId` だけでなく `findJobInstanceIds()`（タグ`sattori:jobId`での
   `DescribeInstances`）の結果も terminate する。タグはインスタンス作成時に
   `TagSpecifications` で付くので、DynamoDBへの書き込みを待たずに発見できる。
3. **定期掃除**: `handlers/sweepOrphanInstances.ts` がEventBridgeのスケジュール
   （`ORPHAN_SWEEP_INTERVAL_MINUTES` = 10分間隔）で走る。**走査の起点がジョブ
   レコードではなくAWS上に実在するインスタンス**（`listTaggedInstances()`）である点が
   要点で、これによりレコードに痕跡が無い孤児も拾える。

### 掃除役の判定（`orphanInstances.ts`）

誤ってterminateすると**ユーザーの録画をその場で殺す**（しかもワーカーは
`SendTaskFailure`すら送れず、15分のハートビートタイムアウトまで誰も気づかない）ため、
判定は徹底して安全側に倒してある:

- 起動から `ORPHAN_INSTANCE_GRACE_MINUTES`（15分）経っていないインスタンスは対象外
  （上記1の窓と`DescribeInstances`の結果整合を吸収する猶予）。起動時刻が読めない
  インスタンスも同様に対象外。
- 判定の主たる根拠は**ジョブのstatusではなくStep Functions実行の生死**
  （`getExecutionLiveness()`。理由は
  [`apps/api/docs/admin-api.md`](../../apps/api/docs/admin-api.md) の緊急停止の項と
  同じ——ワーカーは `SendTaskFailure`より先に`failed`を書くため、statusは実行の生死の
  代理にならない）。実行が終わっている/存在しないジョブのインスタンスは全て孤児。
- 実行が生きているジョブでは**最も新しい1台だけは必ず残す**（今まさに録画している
  可能性がある1台）。それより古い台は、リトライで前の試行のterminateに失敗した残骸。
- `stopRequestedAt`（緊急停止の要求）があるジョブは実行が生きていても1台も残さない。
- 実行の生死やジョブレコードが引けなかったジョブは**丸ごと見送る**（判定できないものは
  terminateしない。次回の掃除で拾えばよい）。

最悪の孤児寿命は「猶予15分 + 掃除間隔10分」＝25分。1ジョブぶんの調査・terminateが
失敗しても他のジョブの掃除は続けるが、**インスタンスの列挙自体に失敗したときは例外を
投げる**（何も掃除できていない実行を成功として記録すると、「毎回起動しているのに永久に
何もしていない」状態が正常に見えてしまうため）。

## 根拠

- **ジョブレコード起点では拾えない孤児がある**のが決め手。`instanceId` が書かれる前に
  Lambda が死んだケース（背景）はレコード側に痕跡が一切残らないため、`JobsTable` を
  いくら走査しても発見できない。タグは `CreateFleet` の `TagSpecifications` で
  インスタンス作成と同時に付くので、DynamoDB への書き込みを待たずに存在が分かる。
- **誤 terminate の代償が孤児の代償より遥かに大きい**。孤児は最大25分の余計な課金で
  済むが、誤って生きた録画を止めると、ワーカーは `SendTaskFailure` を送る間もなく
  消えるためハートビートタイムアウト（15分）まで誰も気づかず、ユーザーの録画が
  そのぶん遅れる。よって判定不能なものは常に「見送る」側へ倒す。

## 採らなかった選択肢

- **ジョブレコードを起点に走査する**（非終端のジョブを列挙し、その `instanceId` を
  調べる）。上記のとおり最も拾いたい孤児を原理的に拾えない。
- **`status` だけで孤児と判定する**。ワーカーは `SendTaskFailure` より先に `failed` を
  書くため、`failed` でも実行は生きていてリトライ中でありうる（
  [`apps/api/docs/admin-api.md`](../../apps/api/docs/admin-api.md) の緊急停止の項と同じ理由）。
- **猶予時間を短くして孤児寿命を縮める**。`DescribeInstances` の結果整合と launch の
  書き込み窓を吸収できなくなり、起動直後の正常なインスタンスを殺しうる。

## 影響範囲

- `apps/api/src/orphanInstances.ts` / `src/handlers/sweepOrphanInstances.ts`
- `apps/api/src/handlers/sfn/launch.ts`（書き込み順序が上記1の前提）
- `apps/api/src/handlers/sfn/handleFailure.ts` / `src/handlers/admin/stopJob.ts`
- `infra/`（EventBridge のスケジュールルール。`infra/README.md`）
- 管理画面（`/admin`）も同じ資源を覗く（`AGENTS.md` §2）
