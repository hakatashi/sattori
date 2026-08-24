import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { SattoriEdgeStack } from "../lib/sattori-edge-stack.ts";

function synth(): Template {
  const app = new App();
  const stack = new SattoriEdgeStack(app, "TestEdgeStack", {
    env: { account: "123456789012", region: "us-east-1" },
    webDomainName: "sattori.hakatashi.com",
    opsAlertEmail: "ops@example.com",
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

  it("SPFアラインメント用にカスタムMAIL FROMドメインを設定している(Issue #139 UX-5)", () => {
    template.hasResourceProperties("AWS::SES::EmailIdentity", {
      MailFromAttributes: Match.objectLike({
        MailFromDomain: "mail.sattori.hakatashi.com",
      }),
    });
    const outputs = template.findOutputs("*");
    const values = Object.values(outputs)
      .map((output) => output.Value)
      .filter((value): value is string => typeof value === "string");
    expect(values.some((value) => value.includes("mail.sattori.hakatashi.com MX"))).toBe(true);
    expect(values.some((value) => value.includes("mail.sattori.hakatashi.com TXT"))).toBe(true);
  });

  it("SESのConfigurationSetがバウンス・苦情・拒否イベントをSNSへ流す(Issue #133 OPS-1)", () => {
    template.resourceCountIs("AWS::SES::ConfigurationSet", 1);
    template.hasResourceProperties("AWS::SES::ConfigurationSetEventDestination", {
      EventDestination: Match.objectLike({
        MatchingEventTypes: Match.arrayWith(["bounce", "complaint", "reject"]),
        SnsDestination: Match.anyValue(),
      }),
    });
  });

  it("運用アラート用SNSトピックにメール購読が1件ある", () => {
    template.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "email",
      Endpoint: "ops@example.com",
    });
  });

  it("SESバウンス率・苦情率のアラームがOPS-1で提案された閾値(2%・0.05%)を持つ", () => {
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "AWS/SES",
      MetricName: "Reputation.BounceRate",
      Threshold: 0.02,
    });
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "AWS/SES",
      MetricName: "Reputation.ComplaintRate",
      Threshold: 0.0005,
    });
  });

  it("月次コストのAWS Budgetsが存在し、メールへ直接通知する(Issue #134 OPS-2)", () => {
    template.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: Match.objectLike({
        BudgetType: "COST",
        TimeUnit: "MONTHLY",
        BudgetLimit: { Amount: 80, Unit: "USD" },
      }),
      NotificationsWithSubscribers: Match.arrayWith([
        Match.objectLike({
          Subscribers: Match.arrayWith([Match.objectLike({ SubscriptionType: "EMAIL" })]),
        }),
      ]),
    });
  });
});
