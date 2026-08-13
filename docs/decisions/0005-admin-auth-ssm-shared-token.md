# 0005. 管理画面の認証は Cognito ではなく SSM の共有トークンにする

- **状態**: 有効
- **決定日**: 2026-07
- **対象**: apps/api / apps/web / infra
- **関連**: Issue #51

管理画面（`/admin`）の利用者は**管理者1人固定**なので、Cognito 等の ID 基盤を使わず、
SSM Parameter Store（SecureString）に置いた共有トークンを Lambda Authorizer で
検証する。**このトークンは CDK では作れないので、`cdk deploy` より前に手で置くこと**
（無いと `/admin/*` が全て 403 になる）。

## 背景

運用調査用にジョブ一覧・詳細・ログ・緊急停止といった強い操作を持つ画面が要る
（Issue #51）。一方でこのサービスはユーザーにアカウントを作らせない設計であり、
ユーザー向けの認可は jobId 自体を秘密値とする方式
（[0004](0004-job-id-as-authorization-secret.md)）で、管理画面には流用できない。

## 決定

- **SSM Parameter Store の `/sattori/admin/token`（SecureString）に共有トークンを置き、
  Lambda Authorizer（`apps/api/src/handlers/admin/authorizer.ts`、ロジックは
  `adminAuth.ts`）が `Authorization: Bearer` を検証する**。
- **CDK は値に一切触れない**。`ssm.StringParameter.fromSecureStringParameterAttributes()`
  で名前を参照するだけで、`grantRead`（ARN のみ）と `kms:ViaService` 条件付きの
  `kms:Decrypt` を付与する。
- トークンの投入・ローテーションは `deploy-sattori` skill の手順で手動で行う。

## 根拠

- **利用者が1人しかいない**。ユーザープール・サインアップ・パスワードリセット・
  MFA といった Cognito の機能は一つも要らず、CDK スタックと運用対象だけが増える。
- **SecureString は CloudFormation / CDK では作成できない**。`.stringValue` を参照すると
  CFn の動的参照 `{{resolve:ssm-secure:...}}` が生成され、**値がテンプレートへ染み出す**。
  そのため「CDK は名前だけ知り、値は手で置く」形が必然になる。
- トークン比較は SHA-256 を経由した固定長の `timingSafeEqual`（長さ不一致による
  `RangeError` 回避と定数時間比較の両立）。

## 採らなかった選択肢

- **Cognito User Pool + Hosted UI**。上記のとおり1人分の ID 基盤としては過剰。
- **IAM 認証（SigV4）で API を保護する**。ブラウザの SPA から SigV4 を組み立てる必要が
  あり、結局どこかに長期キーを置くことになる。
- **トークンを CDK のコンテキストや環境変数で配る**。CFn テンプレート・
  Lambda の環境変数に平文で残る。
- **API Gateway の API キー**。使用量プラン向けの機能で、秘密値の保護を目的とした
  ものではない。

## 影響範囲

- `apps/api/src/adminAuth.ts` / `handlers/admin/authorizer.ts`
- `infra/lib/`（Authorizer と権限付与。`infra/README.md`「管理画面」）
- **失効の反映は最大10分遅れる**（SSM 取得値の実行コンテキスト内キャッシュ 5分 +
  authorizer の `resultsCacheTtl` 5分）。ローテーション直後に旧トークンが通っても
  異常ではない。
- `deploy-sattori` skill（投入・ローテーション手順）
- `AGENTS.md` §3
