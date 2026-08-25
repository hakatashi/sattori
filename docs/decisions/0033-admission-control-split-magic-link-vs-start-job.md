# 0033. 受付制御（キルスイッチ・月間コストガード）は`requestMagicLink`と`startJob`で非対称にチェックする

- **状態**: 有効
- **決定日**: 2026-08-26
- **対象**: apps/api
- **関連**: Issue #130（REL-1）、PR #145

キルスイッチは`POST /magic-links`と`POST /jobs/{jobId}/start`の両方で確認するが、
月間コストガードは`POST /magic-links`でしか確認しない。この非対称は見落としではなく、
それぞれのチェックの代償が異なることを踏まえた意図的な判断である。

## 背景

キルスイッチ（`acceptingNewJobs`）と月間コストガード（`monthlyCostLimitUsd`、
[`0022`](0022-cost-guard-by-estimated-amount-not-job-count.md)）は、当初
`POST /magic-links`（`requestMagicLink.ts`）でしか確認していなかった。しかし
マジックリンク発行後の`pending`ジョブは最大24時間有効なため、`requestMagicLink.ts`側の
受付停止だけでは、既に発行済みのリンクを開かれると`POST /jobs/{jobId}/start`
（`startJob.ts`）経由で録画が始まってしまっていた（Issue #130）。

## 決定

- `startJobFn`が`pending`→`queued`の原子遷移（`startPendingJob()`）を行う**前**に
  `getSettings()`を確認し、キルスイッチが停止中ならジョブを`pending`のまま据え置いて
  503（`service_paused`）を返す。起動済み（`pending`以外）へのアクセスは冪等応答なので
  このチェックを通らず、受付再開後は同じリンクで起動できるため、ユーザー側の損失はゼロ。
- **月間コストガードは`startJob.ts`では確認しない**。キルスイッチのみ`startJob.ts`にも
  効かせる。

## 根拠

- キルスイッチは`SettingsTable`への軽量な1件`GetItem`で、`startJob.ts`のクリティカル
  パスに足しても代償が小さい。
- 月間コストガードの判定値（`getCachedMonthlyCostUsd()`）は`JobsTable`の全件Scanを要する
  （[`0022`](0022-cost-guard-by-estimated-amount-not-job-count.md)）。加えて、
  マジックリンク送信（メールが届く）という「一度成功した」体験の後に`startJob.ts`で
  弾くと、ユーザーから見て「メールは来たのに開始できない」という体験の悪化になる。
  全件Scanのコストとこの体験悪化を天秤にかけ、`startJob.ts`側では見送った。

## 採らなかった選択肢

- **月間コストガードも`startJob.ts`で確認する**。全件Scanを`POST /jobs/{jobId}/start`の
  クリティカルパスに載せることになり、かつ「メール到達後に拒否される」体験が生まれる。
  月間コストガードは「新規の受付を絞る」ためのもので、既に受け付けた（メールを送った）
  ジョブを事後に止める用途には向かない。
- **`startJob.ts`では両方とも確認しない**。Issue #130の実害（受付停止中でも発行済み
  リンクから録画が始まってしまう）を放置することになる。キルスイッチは運用者が
  手動で緊急停止する経路であり、`startJob.ts`を素通りされると停止の意味が薄れる。

## 影響範囲

- `apps/api/src/handlers/startJob.ts`（`getSettings()`確認の位置）
- `apps/api/src/handlers/requestMagicLink.ts`・`costGuard.ts`・`settings.ts`
- `apps/api/README.md` §9「キルスイッチ・月間コストガード」
- `apps/api/docs/admission-control.md`（チェック内容の参照仕様）
