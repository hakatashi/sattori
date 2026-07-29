# infra

AWS CDK（TypeScript）による Sattori のインフラ定義。`SattoriStack`
（`lib/sattori-stack.ts`）一つに集約している。

## リソース一覧

- **S3**: アップロード用バケット（`.rpy`、自動削除なし。サイズが小さく保管コストが
  無視できるため）、出力用バケット（動画+進捗スクリーンショット
  `progress/{jobId}/*.jpg`、7日で自動削除）、タイトル資産バケット
  （`titles/{game}/assets.tar.gz`、Issue #22。`worker/README.md`参照）、
  Webホスティング用バケット。
- **CloudFront**: 動画配信用（`MediaCdn`、OAC非公開）・Web配信用（`WebCdn`、
  カスタムドメイン+ACM証明書）。SPAのフォールバックはCloudFront Function
  （`WebRouting`、ビューワーリクエスト）で行い、拡張子の無いパスを`/en`配下なら
  `/en/index.html`、それ以外は`/index.html`へ書き換える。**errorResponsesによる
  一律フォールバックにはしないこと**: 全パスが日本語版HTMLに落ちてしまい、
  `/en/...`を共有した際のOGP・`<title>`・`<html lang>`を英語に出し分けられなくなる
  （クローラーはJSを実行しないため、React側の書き換えではunfurlに反映されない。
  `apps/web/README.md`「多言語対応」参照）。
  `MediaCdn`は`response-content-disposition`クエリをオリジンへ転送しキャッシュ
  キーにも含める専用の`CachePolicy`（`mediaCachePolicy`）を使う（含めないと720p/
  オリジナル解像度など異なるファイル名のリクエスト間でdispositionヘッダーの
  キャッシュが混線する。`apps/api/README.md`参照）。
- **DynamoDB**: `JobsTable`（`jobId`パーティションキー、オンデマンド課金。
  DynamoDB Streams `NEW_AND_OLD_IMAGES`を有効化し完了メール送信のトリガーに使う）、
  `EmailRateLimitTable`（`normalizedEmail`パーティションキーのみ・1メール1item、
  TTL属性で自動削除。`apps/api/README.md`参照）。
- **SES**: `EmailIdentity`（送信元ドメインのDKIM検証、マジックリンク・完了メール
  送信用）。DKIM用CNAMEは`cdk deploy`後にCfnOutputの値を外部DNSへ手動追加する
  必要がある。また実際にサンドボックス外へ送信するには別途AWSへ申請が必要
  （コードでは自動化できない）。
- **ECR**: `sattori-worker`（`maxImageCount: 2`でストレージコストを抑制。
  ワーカーイメージはタイトル数に依存しない共通部分のみで構成するため、Issue #22で
  タイトル固有アセットをS3側へ分離済み）。
- **VPC**: NATなし公開サブネット×6AZ（`maxAzs: 6`、us-east-1の全AZ数に合わせている。
  ワーカーは外向き通信のみのためNAT不要=コスト増なしでAZを広げられる）+ SG
  （egressのみ）。**us-east-1eは本番AWSアカウントではレガシーAZ**で現行世代
  インスタンスタイプを一切提供しないため、VPC自体は変えず`WORKER_SUBNET_IDS`の
  組み立て時に除外している（Issue #29。VPCの`availabilityZones`明示指定での除外は
  CloudFormationのサブネット差し替えでCIDR重複エラーになり不可、コメント参照）。
- **EC2 Launch Template**: ワーカー起動の基点（AMI/インスタンスタイプ/IAM/SG固定）。
  ジョブ固有のUserDataは**CDKではなく実行時にAWS SDKで**`CreateLaunchTemplateVersion`
  により上書きする（`AGENTS.md`の設計判断参照。ここでのUserDataはプレースホルダで
  実際に使われることはない）。
- **Step Functions**: `RecordingStateMachine`（Standard）。`Launch`
  （`waitForTaskToken`、60分タイムアウト）→ 失敗時 `WaitBeforeCheck`（3分）→
  `HandleFailure` → `ShouldRetry?`（`shouldRetry`なら`IncrementAttempt`して
  `Launch`へ、そうでなければ`Fail`）。`HandleFailure`自体が例外を投げても
  （DynamoDB/EC2 APIの一時的なスロットリング等）実行全体を即失敗させず、
  3回リトライ後になお失敗すれば`HandleFailureCrashed`へ倒して実行を必ず終端させる
  （孤児インスタンスが残る可能性はログに残す）。詳細は`apps/api/README.md`。
- **IAM**: ワーカーロール（ECR pull / S3 / DynamoDB / ログ送出 /
  `states:SendTask*`。`SendTask*`はリソースレベル権限に非対応のため`Resource: "*"`
  がAWS側の制約として必要）+ インスタンスプロファイル、Launch Lambdaロール
  （EC2 Fleet起動 + `iam:PassRole`）、HandleFailure Lambdaロール
  （`ec2:TerminateInstances`）、StartJob Lambdaロール（`states:StartExecution`）、
  RequestMagicLink/SendCompletionEmail Lambdaロール（`JobsTable`等の読み書き +
  `ses:SendEmail`。SESサンドボックス中は送信先IDも権限チェック対象になるため、
  Resourceはアカウント配下のSES identity全体`identity/*`に絞っている）。
- **CloudWatch Logs**: `/sattori/worker`（2週間保持）。ワーカーコンテナが
  `awslogs`ドライバで書き込む。重複フレーム診断のため失敗時も残す。
- **Lambda**（`NodejsFunction`、CJS出力。ESM出力だとAWS SDK内部の動的
  `require("node:https")`がLambda(ESM)で失敗するため）× 8: createUpload /
  parseReplay / requestMagicLink / startJob / getJob / sendCompletionEmail /
  sfn.launch / sfn.handleFailure。`sendCompletionEmail`のみHTTP APIではなく
  `JobsTable`のDynamoDB Streams（`eventName: MODIFY`・`NewImage.status: "done"`
  にフィルタ）をイベントソースとする。
- ワーカーAMIはSSMの ECS 最適化 AL2023（Docker同梱）を参照。

## デプロイ手順

```bash
pnpm build                                                       # web の dist を作る(CDKがBucketDeploymentで配信)
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm --filter @sattori/infra exec cdk bootstrap  # 初回のみ
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm run deploy                # ルートの package.json 経由で cdk deploy を実行
```

1. `pnpm build`（`apps/web/dist`が無いと`BucketDeployment`はスキップされる）
2. `cdk bootstrap`（初回のみ）→ `pnpm run deploy`（`infra`の`deploy`スクリプト
   ＝`cdk deploy`を呼ぶ）
3. ワーカーイメージをECRへ push（`docker build worker/` → `docker push`）
4. ACM証明書のDNS検証用CNAME・SESのDKIM用CNAMEを、`cdk deploy`完了後のCfnOutput
   を確認して外部DNSへ手動追加する（`hakatashi.com`はRoute 53以外で管理しているため
   自動検証はできない）
5. タイトル資産（ゲーム本体+WINEPREFIX+MOD）をS3へアップロードする
   （`worker/README.md`「タイトル資産のS3アップロード手順」参照）

## CDK合成のみ行う場合

```bash
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm --filter @sattori/infra synth
```

> 注: この環境はasdfのpnpmを使う。CDKの`NodejsFunction`は**リポジトリルートから
> `esbuild`をexecする**ため、ルート`devDependencies`に`esbuild`を置いてある。
> corepackのダウンロードプロンプトが出る場合は`COREPACK_ENABLE_DOWNLOAD_PROMPT=0`
> を付ける。

## テスト

`test/`配下でスタック合成のスナップショット/アサーションテスト（vitest）。
`pnpm --filter @sattori/infra test`。
