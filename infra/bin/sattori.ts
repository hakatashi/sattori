#!/usr/bin/env tsx
import { App } from "aws-cdk-lib";
import { SattoriStack } from "../lib/sattori-stack.ts";

const app = new App();

new SattoriStack(app, "SattoriStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    // us-east-1固定。コスト最適化に加え、Web配信CloudFrontにアタッチするACM証明書は
    // us-east-1必須。CDK CLIはAWSプロファイルの既定リージョンをCDK_DEFAULT_REGIONへ
    // 自動注入するため、`?? "us-east-1"` のようなフォールバックはプロファイルの既定
    // リージョンが別にある場合に機能せず、別リージョンへ誤ってスタックを作ってしまう
    // (実際に ap-northeast-1 に空スタックができる事故があった)。環境変数に依存せず
    // 固定する。
    region: "us-east-1",
  },
  description: "Sattori 東方リプレイ録画サービス (フェーズ1)",
});
