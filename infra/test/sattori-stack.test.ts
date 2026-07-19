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

  it("Launch Lambda に EC2 Fleet 起動権限が付与されている", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["ec2:CreateFleet", "ec2:RunInstances"]),
          }),
        ]),
      },
    });
  });

  it("HandleFailure Lambda に EC2 terminate 権限が付与されている", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "ec2:TerminateInstances",
          }),
        ]),
      },
    });
  });

  it("録画ジョブをオーケストレーションする Standard タイプの Step Functions ステートマシンが存在する", () => {
    template.hasResourceProperties("AWS::StepFunctions::StateMachine", {
      StateMachineType: "STANDARD",
    });
  });

  it("ワーカーロールに SendTaskSuccess/SendTaskFailure 権限が付与されている", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["states:SendTaskSuccess", "states:SendTaskFailure"]),
          }),
        ]),
      },
    });
  });

  it("ワーカー起動用の EC2 Launch Template が存在する", () => {
    template.hasResourceProperties("AWS::EC2::LaunchTemplate", {
      LaunchTemplateData: Match.objectLike({
        InstanceInitiatedShutdownBehavior: "terminate",
      }),
    });
  });

  it("CreateJob Lambda に Step Functions 実行開始権限が付与されている", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "states:StartExecution",
          }),
        ]),
      },
    });
  });

  it("CreateJob Lambda に STATE_MACHINE_ARN 環境変数が設定されている", () => {
    const createJobResources = template.findResources("AWS::Lambda::Function", {
      Properties: {
        Environment: {
          Variables: Match.objectLike({
            STATE_MACHINE_ARN: Match.anyValue(),
          }),
        },
      },
    });
    expect(Object.keys(createJobResources).length).toBe(1);
  });
});
