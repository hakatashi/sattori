#!/usr/bin/env tsx
import { App } from "aws-cdk-lib";
import { SattoriStack } from "../lib/sattori-stack.ts";

const app = new App();

new SattoriStack(app, "SattoriStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    // コスト最適化のため既定を us-east-1（最安リージョン）にする。
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
  description: "Sattori 東方リプレイ録画サービス (フェーズ1)",
});
