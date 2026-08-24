import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";

export interface SattoriEdgeStackProps extends StackProps {
  /** Web/メールで共通して使うカスタムドメイン(SattoriStackと同じ値を渡すこと)。 */
  webDomainName: string;
  /**
   * 運用アラート(SESバウンス・苦情率、AWS Budgets)の通知先メールアドレス
   * (Issue #133 OPS-1・#134 OPS-2)。`SattoriStack`側の運用アラート
   * (Step Functions失敗・Lambdaエラー等、Issue #135 OPS-3)にも同じ値を渡すが、
   * SNSトピック自体はリージョンごとに分ける(理由は`docs/decisions/0025`)。
   */
  opsAlertEmail: string;
}

/**
 * us-east-1 固定の付帯スタック。CloudFront にアタッチする ACM 証明書は us-east-1
 * 必須（CloudFrontはグローバルサービスでコントロールプレーンがus-east-1にあるため）
 * であり、加えて SES は本体スタックのリージョン(eu-south-2)には提供されていない
 * （2026-08-03時点、SSMのglobal-infrastructureで確認）。この2つだけをこのスタックで
 * us-east-1に作り、`crossRegionReferences`経由でSattoriStackへ証明書ARNを渡す。
 */
export class SattoriEdgeStack extends Stack {
  /** SattoriStack(CloudFront)へ渡す証明書ARN。同一リージョンで完結していた頃と異なり、
   * `acm.Certificate`をそのまま渡すのではなくARN(string)だけを渡す。crossRegionReferences
   * によるリソース参照はトークン解決の依存が複雑になりやすく、単純な文字列プロパティの
   * 受け渡し + `fromCertificateArn` の方が挙動を追いやすいため。 */
  public readonly certificateArn: string;
  /**
   * SES送信時に指定するConfigurationSet名。`SattoriStack`(eu-south-2)側の
   * Lambda(`requestMagicLink.ts`/`sendCompletionEmail.ts`)へ`SES_CONFIGURATION_SET`
   * 環境変数として渡す(Issue #133 OPS-1)。
   */
  public readonly sesConfigurationSetName: string;

  constructor(scope: Construct, id: string, props: SattoriEdgeStackProps) {
    super(scope, id, props);

    // hakatashi.com は Route 53 以外の DNS で管理しているため、hostedZone による
    // 自動検証はできない。DNS 検証用 CNAME は `cdk deploy` 実行中に ACM コンソール
    // (us-east-1)で確認し、外部 DNS へ手動追加する。このCNAMEはAWS公式仕様上
    // リージョンを跨いで再利用可能なため、以前 us-east-1 単一スタックだった頃に
    // 追加したレコードをそのまま使い回せる(再登録不要)。
    const webCertificate = new acm.Certificate(this, "WebCertificate", {
      domainName: props.webDomainName,
      validation: acm.CertificateValidation.fromDns(),
    });
    this.certificateArn = webCertificate.certificateArn;

    // --- メール送信(SES, マジックリンク認証 Issue #9) -----------------------
    // webDomainName配下から送信する(no-reply@<webDomainName>)。DKIM用のCNAMEは
    // ACM証明書のDNS検証と同様、`cdk deploy`実行後にCfnOutputの値を外部DNSへ
    // 手動追加する必要がある。また実際にサンドボックス外へ送信するには、別途
    // AWSへサンドボックス解除を申請する必要がある(コードでは自動化できない)。
    // SESはこのスタックのリージョン(us-east-1)でのみ検証されるため、
    // SattoriStack側のLambdaは`SES_REGION`環境変数でこのリージョンを指定して呼ぶ。
    // カスタムMAIL FROMドメイン（Issue #139 UX-5）。指定しないとMAIL FROMが
    // `amazonses.com`のままになり、SPFが`webDomainName`とアラインしない
    // （DKIMアラインメントだけでは新規ドメインからの一斉送信でGmail/Yahooの
    // 送信者要件を満たすには不十分になりやすい）。サブドメインは受信用途を持たない
    // 専用のものにする必要がある（`EmailIdentityProps.mailFromDomain`の制約）。
    const mailFromDomain = `mail.${props.webDomainName}`;

    const sesIdentity = new ses.EmailIdentity(this, "SesIdentity", {
      identity: ses.Identity.domain(props.webDomainName),
      mailFromDomain,
    });

    sesIdentity.dkimRecords.forEach((record, index) => {
      new CfnOutput(this, `SesDkimRecord${index}`, {
        value: `${record.name} CNAME ${record.value}`,
      });
    });

    // MAIL FROMドメインのMX・SPF(TXT)レコード。`webDomainName`同様Route 53以外で
    // 管理しているため自動作成できず、値をCfnOutputで確認して外部DNSへ手動追加する
    // 必要がある（`infra/README.md`「デプロイ手順」）。値はAWS公式ドキュメント固定値
    // （SESのリージョン＝このスタックのリージョンus-east-1を埋め込む）。
    new CfnOutput(this, "SesMailFromMxRecord", {
      value: `${mailFromDomain} MX "10 feedback-smtp.${this.region}.amazonses.com"`,
    });
    new CfnOutput(this, "SesMailFromSpfRecord", {
      value: `${mailFromDomain} TXT "v=spf1 include:amazonses.com ~all"`,
    });

    // --- 運用アラート(OPS-1: SESバウンス・苦情監視, OPS-2: AWS Budgets) ------
    // Issue #133・#134。CloudWatchアラームのSNSアクションは同一リージョンの
    // トピックしか指定できないため、us-east-1に常駐するこのリソース(SES・Budgets)
    // 専用のトピックをここに置く。eu-south-2側(Step Functions・Lambda監視、Issue #135)は
    // `SattoriStack`が別途持つ(`docs/decisions/0025`)。
    const opsAlertTopic = new sns.Topic(this, "OpsAlertTopic", {
      displayName: "Sattori Ops Alerts (us-east-1: SES bounce/complaint, Budgets)",
    });
    opsAlertTopic.addSubscription(new subscriptions.EmailSubscription(props.opsAlertEmail));

    // マジックリンク・完了メールの送信時にConfigurationSetNameとして指定する
    // (`apps/api/src/ses.ts`)。バウンス・苦情・拒否イベントをSNSへ流す
    // (`addEventDestination`)のに加え、`reputationMetrics`でこのConfiguration Set
    // 経由の送信を評判ダッシュボードの集計対象にする。
    const configurationSet = new ses.ConfigurationSet(this, "SesConfigurationSet", {
      reputationMetrics: true,
    });
    this.sesConfigurationSetName = configurationSet.configurationSetName;

    configurationSet.addEventDestination("OpsAlertDestination", {
      destination: ses.EventDestination.snsTopic(opsAlertTopic),
      events: [ses.EmailSendingEvent.BOUNCE, ses.EmailSendingEvent.COMPLAINT, ses.EmailSendingEvent.REJECT],
    });

    // アカウント全体のバウンス率・苦情率(`AWS/SES`名前空間の`Reputation.*`、SESが
    // ConfigurationSetの有無によらず自動的に公開する)を監視する。AWSの送信停止ライン
    // (バウンス10%・苦情0.5%)より十分手前の閾値(Issue #133で提案された値をそのまま
    // 採用: バウンス2%・苦情0.05%)で検知し、気づいてから止める時間を確保する。
    // これらのメトリクスは高頻度には更新されないため、Periodを6時間に広げ
    // Maximumで直近の値を拾う(`treatMissingData`はデータが無い期間を異常扱いしない)。
    const reputationAlarmDefaults = {
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    };
    new cloudwatch.Alarm(this, "SesBounceRateAlarm", {
      ...reputationAlarmDefaults,
      alarmDescription:
        "SESアカウントのバウンス率が2%を超えた(AWSの送信停止ラインは10%)。docs/runbooks/ops-alerts.md参照",
      metric: new cloudwatch.Metric({
        namespace: "AWS/SES",
        metricName: "Reputation.BounceRate",
        statistic: "Maximum",
        period: Duration.hours(6),
      }),
      threshold: 0.02,
    }).addAlarmAction(new cwActions.SnsAction(opsAlertTopic));
    new cloudwatch.Alarm(this, "SesComplaintRateAlarm", {
      ...reputationAlarmDefaults,
      alarmDescription:
        "SESアカウントの苦情率が0.05%を超えた(AWSの送信停止ラインは0.5%)。docs/runbooks/ops-alerts.md参照",
      metric: new cloudwatch.Metric({
        namespace: "AWS/SES",
        metricName: "Reputation.ComplaintRate",
        statistic: "Maximum",
        period: Duration.hours(6),
      }),
      threshold: 0.0005,
    }).addAlarmAction(new cwActions.SnsAction(opsAlertTopic));

    // --- AWS Budgets(OPS-2, Issue #134) --------------------------------------
    // Budgetsのメール通知はSNSを経由せず直接送れる(`SubscriptionType: EMAIL`)ため、
    // ここではopsAlertTopicを使わず`props.opsAlertEmail`へ直接紐付ける。
    const budgetNotification = (
      notification: budgets.CfnBudget.NotificationProperty,
    ): budgets.CfnBudget.NotificationWithSubscribersProperty => ({
      notification,
      subscribers: [{ subscriptionType: "EMAIL", address: props.opsAlertEmail }],
    });
    new budgets.CfnBudget(this, "MonthlyCostBudget", {
      budget: {
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: 80, unit: "USD" },
      },
      notificationsWithSubscribers: [50, 80, 100]
        .map((threshold) =>
          budgetNotification({
            notificationType: "ACTUAL",
            comparisonOperator: "GREATER_THAN",
            threshold,
            thresholdType: "PERCENTAGE",
          }),
        )
        .concat(
          budgetNotification({
            notificationType: "FORECASTED",
            comparisonOperator: "GREATER_THAN",
            threshold: 120,
            thresholdType: "PERCENTAGE",
          }),
        ),
    });
  }
}
