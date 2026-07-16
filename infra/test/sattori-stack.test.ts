import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { SattoriStack } from "../lib/sattori-stack.ts";

function synth(): Template {
  const app = new App();
  const stack = new SattoriStack(app, "TestStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  return Template.fromStack(stack);
}

describe("SattoriStack", () => {
  const template = synth();

  it("ジョブ状態テーブルはオンデマンド課金", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
    });
  });

  it("録画ワーカーの ECR リポジトリが存在する", () => {
    template.hasResourceProperties("AWS::ECR::Repository", {
      RepositoryName: "sattori-worker",
    });
  });

  it("CloudFront は配信用と Web 用の2つ", () => {
    template.resourceCountIs("AWS::CloudFront::Distribution", 2);
  });

  it("HTTP API が定義されている", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      ProtocolType: "HTTP",
    });
  });

  it("バケットは3つ以上(アップロード/出力/Web)", () => {
    const buckets = template.findResources("AWS::S3::Bucket");
    expect(Object.keys(buckets).length).toBeGreaterThanOrEqual(3);
  });

  it("createJob Lambda に EC2 起動権限が付与されている", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["ec2:RunInstances"]),
          }),
        ]),
      },
    });
  });
});
