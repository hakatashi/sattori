import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { SattoriEdgeStack } from "../lib/sattori-edge-stack.ts";

function synth(): Template {
  const app = new App();
  const stack = new SattoriEdgeStack(app, "TestEdgeStack", {
    env: { account: "123456789012", region: "us-east-1" },
    webDomainName: "sattori.hakatashi.com",
  });
  return Template.fromStack(stack);
}

describe("SattoriEdgeStack", () => {
  const template = synth();

  it("CloudFront用のACM証明書がDNS検証で定義されている", () => {
    template.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: "sattori.hakatashi.com",
      ValidationMethod: "DNS",
    });
  });

  it("SESのメールIDが検証済みドメイン向けに存在する(Issue #9)", () => {
    template.hasResourceProperties("AWS::SES::EmailIdentity", {
      EmailIdentity: "sattori.hakatashi.com",
    });
  });
});
