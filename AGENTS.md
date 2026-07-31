# AGENTS.md

Sattori（東方リプレイ録画ウェブサービス）の全体設計。このリポジトリで作業する
次のエージェント（または人間）は着手前に必読。**パッケージ固有の詳細は各パッケージの
README.md に分割してある**ので、そちらも合わせて参照すること。ここには
パッケージ・機能を問わず常に踏まえておくべき情報のみを残す。

録画バックエンドの技術的背景（実機検証レポート群）は別リポジトリ
`touhou-recorder`（PoC）の `reports/latest.md` と `AGENTS.md` に詳しい。
このリポジトリの各所で `reports/NN` として参照されるのはそちらのレポート番号。

## 1. サービス概要と現状

東方Projectのリプレイファイル（`.rpy`）をアップロードすると、AWS 上で自動録画し、
動画をダウンロードできる無料サービス。動画に詳しくないファンでも迷わず使えることを
最優先とし、UI は説明を最小限に、操作を単純にする。想定利用規模は**月間最大1000回**の
録画で、コストとオペレーションの最小化を最優先に設計判断を行っている。

主要機能（アップロード→解析プレビュー→マジックリンク認証→録画→ポーリング→
DL→完了メール）はすべて実装済みで、現在は初回リリースに向けた準備段階。
対応タイトルは th06・th07・th08・th11 の4本（`worker/README.md` 参照）。

## 2. アーキテクチャ概観

```
[ブラウザ: React/Vite SPA]
  ① 署名付きURLで .rpy を S3 へ直接 PUT、POST /replays/parse で解析・プレビュー
  ② POST /magic-links でメール認証（マジックリンク）送信要求（status: pending のジョブ作成）
  ③ メール内リンク（ジョブページ）を開くと POST /jobs/{jobId}/start で録画ジョブ起動
  ④ GET /jobs/{id} をポーリングして進捗表示・DL
        │
[API Gateway HTTP API] → [Lambda ハンドラ群] → [DynamoDB: ジョブ状態・メールレート制限カウンタ]
        │ startJob が Step Functions の実行を開始(StartExecution)
        ▼
[Step Functions(Standard, 1ジョブ=1実行)] → EC2 Fleet でワーカーを起動、
   ワーカー自身が taskToken(SendTaskSuccess/Failure)で成否を通知。失敗時は
   孤児インスタンスをterminateしつつ最大10回までリトライ(`apps/api/src/retryPolicy.ts`)
        ▼
[EC2 Fleet ワーカー(Spot, Docker: Wine+Xvfb+ffmpeg+Python)]
   S3から.rpy取得 → 録画 → 生動画をS3へチェックポイントUP →
   720pアップスケール変換 → 変換後動画をS3へUP → DynamoDB更新 →
   taskToken通知 → 自動シャットダウン
        ▼
[S3(出力) → CloudFront(OAC)] → ブラウザからDL
        │ ワーカーがDynamoDBのstatusを"done"に更新
        ▼
[JobsTable DynamoDB Streams] → [Lambda: sendCompletionEmail] → SES で完了メール送信
```

上記に加え、運用調査用の管理画面（`/admin`、共有トークン+Lambda Authorizerで保護、
Issue #51）が同じ API Gateway / DynamoDB / S3 / Step Functions を参照専用で覗く。
詳細は `apps/api/README.md`「管理API」・`apps/web/README.md`「管理画面」参照。

各コンポーネントの詳細は次のREADMEに分割してある。

| コンポーネント | 詳細 |
| --- | --- |
| API契約・ジョブ状態機械・共有型 | [`packages/shared/README.md`](packages/shared/README.md) |
| リプレイパーサー | [`packages/replay-parser/README.md`](packages/replay-parser/README.md) |
| Lambda API・EC2起動・課金/レート制限 | [`apps/api/README.md`](apps/api/README.md) |
| フロントエンド | [`apps/web/README.md`](apps/web/README.md) |
| 録画ワーカー（Python） | [`worker/README.md`](worker/README.md) |
| AWS CDK インフラ | [`infra/README.md`](infra/README.md) |

## 3. 常に踏まえておくべき設計判断

これらはどのパッケージで作業する場合でも影響する、確定済みの全体方針。

- **ウェブ基盤は AWS フルサーバーレスに統一**。録画基盤が AWS 固定（EC2/S3/CloudFront）
  であるため、他クラウドを混ぜるとクロスクラウドの IAM 連携が増える。単一クラウドに
  寄せて運用を単純化している。
- **IaC は AWS CDK（TypeScript）だが、EC2 インスタンスの起動（EC2 Fleet）だけは
  CDK ではなく実行時に AWS SDK で行う**（ベースの Launch Template のみ CDK が作り、
  ジョブ毎の UserData は実行時に `CreateLaunchTemplateVersion` で上書きする）。PoC で
  `terraform-provider-aws` が Spot キャパシティ不足時に無限ハングする問題が判明して
  おり（touhou-recorder `reports/16`）、IaC でインスタンスを直接作らない方針を
  踏襲している。新しいインフラを足す際もこの分離を崩さないこと。
- **録画ジョブは Step Functions（Standard）でオーケストレーションする**。1ジョブ=1実行。
  Spot 中断・タイムアウトからの自動リトライ、孤児インスタンスの後始末を担う
  （詳細は `apps/api/README.md`・`infra/README.md`）。
- **進捗はポーリング**（WebSocket/SSE は月1000回規模には過剰という判断）。ワーカーが
  DynamoDB を更新し、`GET /jobs/{id}` が返す。
- **配信は必ず CloudFront 経由**（S3 直リンク禁止）。CloudFront 永年無料枠で egress を
  実質ゼロにできる。
- **録画ワーカーだけ Python**。PoC の numpy/PIL によるフレーム差分・Wine 制御が
  実証済みで、TS 再実装はリスクだけ増えるための判断。フロント・API・パーサー・IaC は
  TypeScript。
- **jobId 自体が認可の秘密値**（マジックリンクのトークンではなく jobId をそのまま
  使う設計）。メールを確認しないと分からない値であることを利用してbot/濫用対策と
  メール認証を兼ねている。
- **管理画面（`/admin`）の認証はこれとは別系統**。管理者はサービス運営者1人固定で
  今後複数ユーザーに拡張する予定がないため、Cognito等は使わず SSM Parameter Store
  （SecureString）に置いた共有トークンを Lambda Authorizer で検証する方式にしている。
  トークンは CDK ではなく `cdk deploy` の前に手動で SSM へ投入する運用（SecureString
  は CloudFormation/CDK では作成できないAWS側の制約のため）。詳細は
  `infra/README.md`「管理画面」・`CLAUDE.local.md`参照。
- **インスタンスタイプ・録画パイプラインの変更は必ず実機検証を経ること**。
  「同スペック帯・同価格帯だから安全」という推測は繰り返し裏切られている
  （高クロック特化インスタンスでの重複フレーム率悪化、既存タイトルの命名則・
  実行ファイル名の慣習を新タイトルへ無検証で流用して発生した不具合など）。
  変更の妥当性は touhou-recorder のレポートか、このリポジトリでの実機/実データ
  スモークテストの記録で必ず裏付けること。

## 4. モノレポ構成

pnpm workspaces + Turborepo。ルートに `pnpm-workspace.yaml` / `turbo.json` /
`tsconfig.base.json`。Node 24 / pnpm 10.33（`.tool-versions` で asdf 管理）。

| パッケージ | 役割 | 主なツール |
| --- | --- | --- |
| `packages/shared` | 型定義（ゲーム・リプレイ・ジョブ・API 契約） | tsc, vitest |
| `packages/replay-parser` | `.rpy` デコーダ。npm パッケージ名は `@sattori/touhou-replay-parser`（`@sattori/shared` 非依存でOSS公開可能な設計） | tsc, vitest |
| `apps/api` | Lambda ハンドラ・S3/DynamoDB/EC2/Step Functions 連携 | tsc(--noEmit), vitest |
| `apps/web` | フロントエンド SPA（`react-router-dom`） | vite, vitest, jsdom |
| `worker` | 録画パイプライン（Python） | python, docker |
| `infra` | AWS CDK スタック | cdk, tsx, vitest |

### TypeScript の約束事（全 TS パッケージ共通）
- `tsconfig.base.json` は `NodeNext` + `verbatimModuleSyntax` + `strict` +
  `noUncheckedIndexedAccess`。
- **相対 import は `.js` 拡張子で書く**（emit される JS に合わせる NodeNext 流儀）。
  `apps/web` と `infra` は Bundler 解決なので `.ts` 拡張子（`allowImportingTsExtensions`）。
- テストファイルは tsc の `build` から除外し、vitest の `include: src/**/*.test.ts` で拾う。

### コマンド
```bash
pnpm install
pnpm build / pnpm test / pnpm typecheck        # turbo で全パッケージ横断
pnpm --filter @sattori/web dev                 # フロント開発サーバ(:5173, /api を :8787 へproxy)
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm --filter @sattori/infra synth   # CDK 合成
```
> 注: この環境は asdf の pnpm を使う。CDK の NodejsFunction は**リポジトリルートから
> `esbuild` を exec する**ため、ルート devDependencies に `esbuild` を置いてある。
> corepack のダウンロードプロンプトが出る場合は `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` を付ける。

デプロイ手順は `infra/README.md`、ワーカーイメージ・タイトル資産のビルド/アップロード
手順は `worker/README.md` を参照。

## 5. ジョブ状態機械（横断的に使われる）

`pending → queued → launching → recording → converting → done | failed`
（`packages/shared/src/job.ts`）。フロントエンド・API・ワーカーの3者が共通で参照する
ため、状態の意味を変える場合は3パッケージすべての整合を確認すること。詳細は
`packages/shared/README.md`。

## 6. 今後の展開・既知の制約

- 対応タイトル拡大（th09/th10/th12以降…）: リプレイパーサー自体は th06〜th20 の
  大半に対応済みだが、録画対応（Wine上でのMOD移植・実機検証）が主な残作業
  （`worker/README.md` 参照）。
- 複数 EC2 同時起動時の負荷検証は未実施（1インスタンス=1ジョブ分離のため問題ない
  と推測しているが、実運用規模拡大時は要注意）。
- 録画がリプレイと一致しているかの自動デシンク検知は未実装（目視のみ）。
- レート制限・濫用対策の強化、コスト監視は継続課題。
- 管理画面（Issue #51）は現状ジョブ一覧・詳細・ダウンロード導線・workerの
  CloudWatchログ表示（Issue #58）のみ（参照系）。ジョブの緊急停止・再実行、
  コスト推定・集計・可視化は後続Issueに切り出し済みで未実装。
