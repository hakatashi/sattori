import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { SattoriGpuFallbackStack } from "../lib/sattori-gpu-fallback-stack.ts";

function synth(): Template {
  const app = new App({
    context: { gpuWorkerAmiIds: { "eu-north-1": "ami-0fedcba9876543210" } },
  });
  const stack = new SattoriGpuFallbackStack(app, "TestGpuFallbackStack", {
    env: { account: "123456789012", region: "eu-north-1" },
  });
  return Template.fromStack(stack);
}

describe("SattoriGpuFallbackStack（Issue #296）", () => {
  const template = synth();

  it("NATを持たない、g6f.2xlargeを提供する2AZだけのパブリックサブネット構成", () => {
    template.resourceCountIs("AWS::EC2::NatGateway", 0);
    const subnets = Object.values(template.findResources("AWS::EC2::Subnet"));
    expect(subnets.map((subnet) => subnet.Properties.AvailabilityZone).sort()).toEqual([
      "eu-north-1a",
      "eu-north-1b",
    ]);
  });

  it("Launch Lambdaが引けるようサブネットにタグを付ける", () => {
    const subnets = Object.values(template.findResources("AWS::EC2::Subnet"));
    for (const subnet of subnets) {
      expect(subnet.Properties.Tags).toEqual(
        expect.arrayContaining([{ Key: "sattori:gpuWorkerSubnet", Value: "true" }]),
      );
    }
  });

  it("GPU Launch Templateは固定名・コピーしたAMI・本体の固定名プロファイルを使う", () => {
    template.hasResourceProperties("AWS::EC2::LaunchTemplate", {
      LaunchTemplateName: "sattori-gpu-worker",
      LaunchTemplateData: Match.objectLike({
        ImageId: "ami-0fedcba9876543210",
        InstanceType: "g6f.2xlarge",
        IamInstanceProfile: { Name: "sattori-gpu-worker-remote" },
        InstanceInitiatedShutdownBehavior: "terminate",
      }),
    });
  });

  it("ECRレプリカの受け皿をライフサイクル付きで先に作る", () => {
    template.hasResourceProperties("AWS::ECR::Repository", {
      RepositoryName: "sattori-worker-gpu",
      LifecyclePolicy: Match.anyValue(),
    });
  });

  it("データ面(S3・DynamoDB)は持たない", () => {
    template.resourceCountIs("AWS::S3::Bucket", 0);
    template.resourceCountIs("AWS::DynamoDB::Table", 0);
  });

  it("フォールバック先のAMIが未設定ならsynth自体が失敗する", () => {
    const app = new App({
      context: { gpuWorkerAmiIds: { "eu-south-2": "ami-0123456789abcdef0" } },
    });
    expect(
      () =>
        new SattoriGpuFallbackStack(app, "NoAmi", {
          env: { account: "123456789012", region: "eu-north-1" },
        }),
    ).toThrow(/eu-north-1/);
  });
});
