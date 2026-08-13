#!/usr/bin/env tsx
import { App } from "aws-cdk-lib";
import { SattoriEdgeStack } from "../lib/sattori-edge-stack.ts";
import { SattoriStack } from "../lib/sattori-stack.ts";

const app = new App();

const WEB_DOMAIN_NAME = "sattori.hakatashi.com";

// CloudFrontにアタッチするACM証明書はus-east-1必須。加えてeu-south-2にはSESが
// 存在しない(2026-08-03時点、SSMのglobal-infrastructureで確認)ため、この2つだけを
// us-east-1固定の`SattoriEdgeStack`に置く(詳細は同スタックのコメント参照)。
const EDGE_REGION = "us-east-1";
// 本体。Spot単価が実測18リージョン中最安(docs/research/aws-region-cost-analysis.md)で、
// 録画品質もtouhou-recorder reports/42・43で実機検証済み。CDK CLIはAWSプロファイルの
// 既定リージョンをCDK_DEFAULT_REGIONへ自動注入するため、`?? "eu-south-2"`のような
// フォールバックはプロファイルの既定リージョンが別にある場合に機能せず、別リージョンへ
// 誤ってスタックを作ってしまう(実際に ap-northeast-1 に空スタックができた事故がある)。
// 環境変数に依存せず固定する。
const MAIN_REGION = "eu-south-2";

const account = process.env.CDK_DEFAULT_ACCOUNT;

const edgeStack = new SattoriEdgeStack(app, "SattoriEdgeStack", {
  env: { account, region: EDGE_REGION },
  crossRegionReferences: true,
  webDomainName: WEB_DOMAIN_NAME,
  description: "Sattori 東方リプレイ録画サービス - ACM証明書・SES(us-east-1固定)",
});

const mainStack = new SattoriStack(app, "SattoriStack", {
  env: { account, region: MAIN_REGION },
  crossRegionReferences: true,
  webDomainName: WEB_DOMAIN_NAME,
  webCertificateArn: edgeStack.certificateArn,
  sesRegion: EDGE_REGION,
  description: "Sattori 東方リプレイ録画サービス (フェーズ1)",
});
mainStack.addDependency(edgeStack);
