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
  ① 署名付きURLで .rpy を S3 へ直接 PUT。解析・プレビューは`@sattori/touhou-replay-parser`
     （ゼロ依存でブラウザでも動作）をブラウザ内でそのまま呼んで即座に行い、アップロード
     完了を待たない（S3 PUT と並行実行。バックエンドの `POST /replays/parse` は同じ解析
     ロジックのAPIとして残しているが、ページAの標準フローからは呼ばれない）
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
Issue #51）が同じ API Gateway / DynamoDB / S3 / Step Functions を覗く（参照系に加え、
ジョブの緊急停止・再実行のみ更新系。Issue #59）。コスト推定・集計（Issue #60）も
同じ DynamoDB のジョブレコードから算出する。
詳細は `apps/api/README.md`「管理API」・`apps/web/README.md`「管理画面」参照。

**本体のAWSリージョンは `eu-south-2`（スペイン）**（2026-08移設、Spot単価が実測
最安のため。`docs/aws-region-cost-analysis.md`参照）。ただし **SESだけ`us-east-1`に
残している**（eu-south-2にはSESが存在しないため）。マジックリンク・完了メールを
送るLambdaは`SES_REGION`環境変数でus-east-1を明示して`SESv2Client`を呼ぶ
（`apps/api/src/ses.ts`）。CloudFrontにアタッチするACM証明書もus-east-1必須のため、
SESと合わせて`SattoriEdgeStack`（us-east-1固定の付帯スタック、`infra/README.md`
参照）にまとめてある。

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
- **単一クラウドに寄せて運用を単純化する方針の唯一の例外がSES**。eu-south-2には
  SESが存在しないため、メール送信だけus-east-1のSESをクロスリージョンで呼んでいる
  （上記§2参照）。障害切り分けの際はこの例外を忘れないこと。また、eu-south-2は
  `c6i`/`c6a`/`c5a`系のインスタンスタイプが存在せず、us-east-1運用時（Issue #29で
  確保した30プール/6タイプ、th11は20プール/4タイプ）に比べてEC2 FleetのSpot
  キャパシティプール数が後退している（th06/07/08は12プール/4タイプ、th11は
  9プール/3タイプ。`c7i`/`c7a`/`c7i-flex`/`m7i`はいずれもeu-south-2実機検証済み、
  touhou-recorder reports/42・43、`apps/api/src/ec2.ts`参照）。起動失敗率が有意に
  悪化していないか移設後しばらくは監視すること。
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
- 管理画面（Issue #51）はジョブ一覧・詳細・ダウンロード導線・workerのCloudWatch
  ログ表示（Issue #58）・ジョブの緊急停止/再実行（Issue #59）・コスト推定と
  日次/週次/月次集計（Issue #60）まで実装済み。
- **コスト表示は推定値であって請求額ではない**（`packages/shared/src/cost.ts`、
  単価は`docs/aws-region-cost-analysis.md`のeu-south-2・2026-08-03時点）。
  リージョンや候補インスタンスタイプを変える場合は単価定数も併せて見直すこと。
  管理画面はUSD/円を切り替えて表示できるが、**円換算は固定レート定数**
  （`USD_TO_JPY_RATE`、2026-08-03時点）による概算で、計算・API応答はすべてUSDのまま
  （換算は表示の直前だけ）。
  CloudFrontの無料枠(1TB/月)は月1000録画でほぼ使い切る水準にあり、超えた時点で
  リージョン差など一瞬で吹き飛ぶ規模の課金が始まる（同 §6）。管理画面のコストページで
  枠の消化率を監視できるようにしてある。
