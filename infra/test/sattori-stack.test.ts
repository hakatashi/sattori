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

  it("StartJob Lambda に Step Functions 実行開始権限が付与されている", () => {
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

  it("StartJob Lambda に STATE_MACHINE_ARN 環境変数が設定されている", () => {
    const startJobResources = template.findResources("AWS::Lambda::Function", {
      Properties: {
        Environment: {
          Variables: Match.objectLike({
            STATE_MACHINE_ARN: Match.anyValue(),
          }),
        },
      },
    });
    expect(Object.keys(startJobResources).length).toBe(1);
  });

  it("レート制限用のDynamoDBテーブルが存在する(Issue #9、token廃止によりMagicLinksTableは無い)", () => {
    template.resourceCountIs("AWS::DynamoDB::Table", 2); // Jobs/EmailRateLimit
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [{ AttributeName: "normalizedEmail", KeyType: "HASH" }],
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
    });
  });

  it("SESのメールIDが検証済みドメイン向けに存在する(Issue #9)", () => {
    template.hasResourceProperties("AWS::SES::EmailIdentity", {
      EmailIdentity: "sattori.hakatashi.com",
    });
  });

  it("マジックリンク関連のHTTP APIルートが定義されている(tokenを使わないjobId単独の起動方式)", () => {
    const routes = template.findResources("AWS::ApiGatewayV2::Route");
    const routeKeys = Object.values(routes).map(
      (route) => (route as { Properties: { RouteKey: string } }).Properties.RouteKey,
    );
    expect(routeKeys).toEqual(
      expect.arrayContaining(["POST /magic-links", "POST /jobs/{jobId}/start"]),
    );
    expect(routeKeys).not.toContain("POST /jobs");
    expect(routeKeys).not.toContain("POST /jobs/{jobId}/confirm");
    expect(routeKeys).not.toContain("POST /jobs/{jobId}/resend");
  });

  it("マジックリンク送信Lambdaに ses:SendEmail 権限が付与されている", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "ses:SendEmail",
          }),
        ]),
      },
    });
  });

  it("JobsTableのDynamoDB Streamsが有効になっている(Issue #10、完了メール送信のトリガー用)", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [{ AttributeName: "jobId", KeyType: "HASH" }],
      StreamSpecification: { StreamViewType: "NEW_AND_OLD_IMAGES" },
    });
  });

  it("SendCompletionEmail LambdaがJobsTableのStreamsをイベントソースとし、statusがdoneへの変更だけに絞り込まれている(Issue #10)", () => {
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      FilterCriteria: {
        Filters: Match.arrayWith([
          Match.objectLike({
            Pattern: Match.serializedJson(
              Match.objectLike({
                eventName: ["MODIFY"],
                dynamodb: { NewImage: { status: { S: ["done"] } } },
              }),
            ),
          }),
        ]),
      },
    });
  });
});
