# 0020. taskToken の秘匿は散文の約束ではなく型で強制する

- **状態**: 有効
- **決定日**: 2026-08
- **対象**: apps/api / packages/shared

ワーカーコンテナへ渡す環境変数（`workerEnv.ts` の `buildWorkerEnv()`）には
`TASK_TOKEN` —— Step Functions の実行を任意に成功/失敗させられるベアラ —— が含まれる。
外部へ出す際に `redactWorkerEnv()` を通す約束を**型で強制**してあり、
`JobRecord` をそのまま返そうとするとコンパイルエラーになる。この仕掛けを外さないこと。

## 背景

自宅ワーカー（Issue #49）へのオファーは、コンテナへ渡す環境変数一式を
`JobRecord.homeWorkerEnv` に書いて渡す（[`0018`](0018-home-worker-pull-assignment.md)）。
一方、管理API の `GET /admin/jobs/{jobId}` は `JobRecord` をほぼそのまま返す。

「ログや外部出力では `redactWorkerEnv()` を通すこと」という散文の約束だけだった間、
**実際に `GET /admin/jobs/{jobId}` が生きた taskToken をそのまま返していた**。
管理APIは共有トークンで保護されているとはいえ、ベアラをそのまま配るのは明確な誤りで、
かつ「気をつける」では再発が防げないことが実証されてしまった。

## 決定

`redactWorkerEnv()` の戻り値だけがブランド付きの型 `RedactedWorkerEnvironment` になり、
管理APIのレスポンス型 `AdminJobRecord.homeWorkerEnv` はその型しか受け付けない。
`JobRecord` → `AdminJobRecord` の変換口は `toAdminJobRecord()` の1箇所だけである。

## 根拠

- 秘密値の漏洩は「レビューで気をつける」類の規律では止まらない（実際に漏れた）。
  ブランド付きの型にすれば、伏せ忘れは**実行時ではなくコンパイル時に落ちる**。
- 変換口を1箇所に絞ることで、新しい管理APIエンドポイントを足したときも
  `AdminJobRecord` を返す限り自動的に伏せられる。

## 採らなかった選択肢

- **`homeWorkerEnv` を `JobRecord` に持たせない**（別テーブル・別属性にする）。
  オファーは条件付き更新1回で原子的に書く必要があり
  （[`0018`](0018-home-worker-pull-assignment.md)）、レコードを分けると
  claim との原子性が崩れる。
- **レスポンス組み立て時に手で `delete` する**。まさにそれが漏れた原因である。
- **taskToken を DynamoDB に置かず、デーモンへ別経路で渡す**。オファーの書き込みが
  トークンを渡す唯一の経路であること自体が、`handleOfferConflict()` の判別根拠に
  なっている（[`0018`](0018-home-worker-pull-assignment.md)）ため崩したくない。

## 影響範囲

- `apps/api/src/workerEnv.ts`（`buildWorkerEnv()` / `redactWorkerEnv()`）
- `apps/api/src/adminJobs.ts` の `toAdminJobRecord()`（唯一の変換口）
- `packages/shared`（`AdminJobRecord` / `RedactedWorkerEnvironment` の型定義）
- 管理APIに `JobRecord` 由来のフィールドを足すときは `AdminJobRecord` 経由にすること
  （[`apps/api/docs/admin-api.md`](../../apps/api/docs/admin-api.md)）
