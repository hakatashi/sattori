import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ses from "aws-cdk-lib/aws-ses";
import type { Construct } from "constructs";

export interface SattoriEdgeStackProps extends StackProps {
  /** Web/メールで共通して使うカスタムドメイン(SattoriStackと同じ値を渡すこと)。 */
  webDomainName: string;
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
    const sesIdentity = new ses.EmailIdentity(this, "SesIdentity", {
      identity: ses.Identity.domain(props.webDomainName),
    });

    sesIdentity.dkimRecords.forEach((record, index) => {
      new CfnOutput(this, `SesDkimRecord${index}`, {
        value: `${record.name} CNAME ${record.value}`,
      });
    });
  }
}
