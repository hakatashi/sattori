import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { LAUNCH_LAMBDA_TIMEOUT_SECONDS, ORPHAN_SWEEP_INTERVAL_MINUTES } from "@sattori/shared";
import { SattoriStack } from "../lib/sattori-stack.ts";

function synth(): Template {
  const app = new App();
  const stack = new SattoriStack(app, "TestStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
    webDomainName: "sattori.hakatashi.com",
    webCertificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/dummy",
    sesRegion: "us-east-1",
    sesConfigurationSetName: "test-config-set",
    opsAlertEmail: "ops@example.com",
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

  it("ECRリポジトリのライフサイクルポリシーは最大2世代保持(Issue #22、タイトル追加に伴うストレージコスト対策)", () => {
    template.hasResourceProperties("AWS::ECR::Repository", {
      LifecyclePolicy: {
        LifecyclePolicyText: Match.serializedJson(
          Match.objectLike({
            rules: Match.arrayWith([
              Match.objectLike({
                selection: Match.objectLike({ countType: "imageCountMoreThan", countNumber: 2 }),
              }),
            ]),
          }),
        ),
      },
    });
  });

  it("タイトル固有アセット用バケットが存在し、ワーカーロールに読み取り権限が付与されている(Issue #22)", () => {
    const buckets = template.findResources("AWS::S3::Bucket");
    expect(Object.keys(buckets).length).toBeGreaterThanOrEqual(4);

    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["s3:GetObject*"]),
          }),
        ]),
      },
      Roles: Match.arrayWith([Match.objectLike({ Ref: Match.stringLikeRegexp("^WorkerRole") })]),
    });
  });

  it("全ハンドラの共通環境変数に TITLE_ASSETS_BUCKET が設定されている(Issue #22)", () => {
    const resources = template.findResources("AWS::Lambda::Function", {
      Properties: {
        Environment: {
          Variables: Match.objectLike({
            TITLE_ASSETS_BUCKET: Match.anyValue(),
          }),
        },
      },
    });
    // commonEnv を使う全ハンドラ数(createUpload/parseReplay/requestMagicLink/getJob/
    // sendCompletionEmail/launch/handleFailure/startJob)分だけ存在するはず。
    expect(Object.keys(resources).length).toBeGreaterThanOrEqual(8);
  });

  it("送信元アドレスに表示名を付け、問い合わせ先をReply-Toとして渡している(Issue #139 UX-5)", () => {
    const resources = template.findResources("AWS::Lambda::Function", {
      Properties: {
        Environment: {
          Variables: Match.objectLike({
            SES_FROM_ADDRESS: "Sattori <no-reply@sattori.hakatashi.com>",
            SES_REPLY_TO_ADDRESS: "ops@example.com",
          }),
        },
      },
    });
    expect(Object.keys(resources).length).toBeGreaterThanOrEqual(1);
  });

  it("CloudFront は配信用と Web 用の2つ", () => {
    template.resourceCountIs("AWS::CloudFront::Distribution", 2);
  });

  it("Web 配信は CloudFront Function で言語別に SPA フォールバックする(OGPの言語出し分け)", () => {
    // errorResponses による全パス一律の /index.html フォールバックだと `/en/...` にも
    // 日本語版HTMLが配られてしまうため、ビューワーリクエスト関数で振り分けている。
    const functions = template.findResources("AWS::CloudFront::Function");
    const codes = Object.values(functions).map(
      (fn) => (fn.Properties as { FunctionCode: string }).FunctionCode,
    );
    expect(codes).toHaveLength(1);
    expect(codes[0]).toContain("/en/index.html");

    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Comment: "Sattori Web",
        CustomErrorResponses: Match.absent(),
        DefaultCacheBehavior: Match.objectLike({
          FunctionAssociations: [
            Match.objectLike({ EventType: "viewer-request" }),
          ],
        }),
      }),
    });
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
            Action: Match.arrayWith([
              "ec2:CreateFleet",
              "ec2:RunInstances",
              // 確保したインスタンスのSpot単価をコスト推定用に記録する(Issue #60)。
              "ec2:DescribeSpotPriceHistory",
            ]),
          }),
        ]),
      },
    });
  });

  it("HandleFailure Lambda に EC2 terminate 権限とタグ検索(DescribeInstances)権限が付与されている", () => {
    // タグ検索はinstanceId未記録のまま死んだ試行の孤児を拾うため(Issue #23)。
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["ec2:TerminateInstances", "ec2:DescribeInstances"]),
          }),
        ]),
      },
      Roles: Match.arrayWith([
        Match.objectLike({ Ref: Match.stringLikeRegexp("^HandleFailureFnServiceRole") }),
      ]),
    });
  });

  it("孤児インスタンスの定期掃除ルールが共有定数の間隔で掃除Lambdaを叩く(Issue #23)", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: `rate(${ORPHAN_SWEEP_INTERVAL_MINUTES} minutes)`,
      State: "ENABLED",
      Targets: Match.arrayWith([
        Match.objectLike({
          Arn: Match.objectLike({
            "Fn::GetAtt": Match.arrayWith([Match.stringLikeRegexp("^SweepOrphanInstancesFn")]),
          }),
        }),
      ]),
    });
  });

  it("孤児掃除Lambdaにインスタンスの列挙・終了権限が付与されている(Issue #23)", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        // `Match.arrayWith` は順序も見るため、テンプレート上の並び（grant→addToRolePolicy）に合わせる。
        Statement: Match.arrayWith([
          // 実行の生死はジョブのstatusで代用できないため DescribeExecution を引く。
          Match.objectLike({ Action: "states:DescribeExecution" }),
          Match.objectLike({
            Action: Match.arrayWith(["ec2:DescribeInstances", "ec2:TerminateInstances"]),
          }),
        ]),
      },
      Roles: Match.arrayWith([
        Match.objectLike({ Ref: Match.stringLikeRegexp("^SweepOrphanInstancesFnServiceRole") }),
      ]),
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

  it("Launch Lambda のタイムアウトは共有定数と一致する(オファー待機の上限の根拠)", () => {
    // `apps/api` の `MAX_OFFER_WINDOW_SECONDS` はこの値から導出されている。
    // ここで直値に戻すと、オファー待機の上限だけが実態から乖離する。
    const launchFunctions = template.findResources("AWS::Lambda::Function", {
      Properties: {
        Handler: Match.anyValue(),
        Timeout: LAUNCH_LAMBDA_TIMEOUT_SECONDS,
        Environment: {
          Variables: Match.objectLike({ WORKERS_TABLE: Match.anyValue() }),
        },
      },
    });
    expect(Object.keys(launchFunctions).length).toBeGreaterThanOrEqual(1);
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

  it("STATE_MACHINE_ARN 環境変数を個別付与されているLambdaは5つ(循環依存回避のためcommonEnvに含めていない)", () => {
    // StartJob / AdminGetExecution / AdminStopJob / AdminRetryJob / SweepOrphanInstances
    // (AdminStopJob・AdminRetryJobはIssue #59のジョブ緊急停止・再実行、
    // SweepOrphanInstancesはIssue #23の孤児インスタンス掃除)。
    const startJobResources = template.findResources("AWS::Lambda::Function", {
      Properties: {
        Environment: {
          Variables: Match.objectLike({
            STATE_MACHINE_ARN: Match.anyValue(),
          }),
        },
      },
    });
    expect(Object.keys(startJobResources).length).toBe(5);
  });

  it("レート制限用のDynamoDBテーブルが存在する(Issue #9、token廃止によりMagicLinksTableは無い)", () => {
    // Jobs/Workers(Issue #49)/EmailRateLimit/Settings(Issue #14)/AnalyticsEvents(Issue #142)
    template.resourceCountIs("AWS::DynamoDB::Table", 5);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [{ AttributeName: "normalizedEmail", KeyType: "HASH" }],
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
    });
  });

  it("SESのEmailIdentityはSattoriEdgeStack側に存在し、SattoriStackには無い(eu-south-2にSESが無いため)", () => {
    template.resourceCountIs("AWS::SES::EmailIdentity", 0);
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

  it("動画配信CDNがresponse-content-dispositionクエリをオリジンへ転送・キャッシュキーに含める(ダウンロードのファイル名指定用)", () => {
    template.hasResourceProperties("AWS::CloudFront::CachePolicy", {
      CachePolicyConfig: Match.objectLike({
        ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
          QueryStringsConfig: {
            QueryStringBehavior: "whitelist",
            QueryStrings: ["response-content-disposition"],
          },
        }),
      }),
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

  it("JobsTableに管理画面(Issue #51)用のGSI(PK=status, SK=createdAt, Projection=ALL)が存在する", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: "StatusCreatedAtIndex",
          KeySchema: [
            { AttributeName: "status", KeyType: "HASH" },
            { AttributeName: "createdAt", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        }),
      ]),
    });
    // GSI追加はテーブル数を変えない(上のテーブル数アサーションと矛盾しないことの
    // 確認を兼ねる)。
    template.resourceCountIs("AWS::DynamoDB::Table", 5);
  });

  it("JobsTableに自宅ワーカー(Issue #49)のオファー用sparse GSIが存在する", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: "HomeWorkerOfferIndex",
          KeySchema: [
            { AttributeName: "homeWorkerOfferState", KeyType: "HASH" },
            { AttributeName: "homeWorkerOfferExpiresAt", KeyType: "RANGE" },
          ],
        }),
      ]),
    });
  });

  it("常駐ワーカーのハートビート用テーブル(WorkersTable)がTTL付きで存在する", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [{ AttributeName: "workerId", KeyType: "HASH" }],
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
    });
  });

  it("Launchタスクにハートビートタイムアウトが設定されている(自宅ワーカーの死活監視)", () => {
    // ワーカーが15分間`SendTaskHeartbeat`を送らなければ失敗させ、HandleFailureが
    // claim解除・孤児掃除を行う。自宅マシンの停電・回線断はAWS側から観測できないため、
    // この仕組みが無いとタスクタイムアウト(90分)までジョブが固まる。
    const machines = template.findResources("AWS::StepFunctions::StateMachine");
    // 定義はFn::Joinの断片に分かれ、さらにJSON文字列として二重にエスケープされて
    // いるため、バックスラッシュを落としてから素朴に含有チェックする。
    const definition = JSON.stringify(Object.values(machines)[0]).replaceAll("\\", "");
    expect(definition).toContain('"HeartbeatSeconds":900');
  });

  it("自宅ワーカー用のIAMロールがアカウント内からのAssumeRoleを許可している", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      Description: "Sattori home recording worker (Issue #49)",
      // ジョブ1本の最長所要時間(録画60分+変換)より確実に長いこと。短いと
      // 録画の途中でコンテナ内のAWS呼び出しが認証エラーで落ちる。
      MaxSessionDuration: 4 * 3600,
    });
  });

  it("管理画面(`/admin/*`)のHTTP APIルートがLambda Authorizerで保護されている", () => {
    const routes = template.findResources("AWS::ApiGatewayV2::Route");
    const routeEntries = Object.values(routes) as {
      Properties: { RouteKey: string; AuthorizationType?: string; AuthorizerId?: unknown };
    }[];

    const adminRouteKeys = [
      "GET /admin/jobs",
      "GET /admin/jobs/{jobId}",
      "GET /admin/jobs/{jobId}/execution",
      // Issue #59。DELETEを使うとcorsPreflight.allowMethodsの拡張も要るためPOSTに揃えている。
      "POST /admin/jobs/{jobId}/stop",
      "POST /admin/jobs/{jobId}/retry",
      // Issue #60。コスト推定の日次/週次/月次集計。
      "GET /admin/costs",
    ];
    for (const routeKey of adminRouteKeys) {
      const route = routeEntries.find((r) => r.Properties.RouteKey === routeKey);
      expect(route, `route ${routeKey} が見つからない`).toBeTruthy();
      expect(route?.Properties.AuthorizationType).toBe("CUSTOM");
      expect(route?.Properties.AuthorizerId).toBeTruthy();
    }

    // 既存のユーザー向けルートには誤ってauthorizerが付いていないことを確認する。
    const publicRouteKeys = ["GET /jobs/{jobId}", "POST /jobs/{jobId}/start", "POST /magic-links"];
    for (const routeKey of publicRouteKeys) {
      const route = routeEntries.find((r) => r.Properties.RouteKey === routeKey);
      expect(route?.Properties.AuthorizerId).toBeFalsy();
    }
  });

  it("緊急停止Lambdaに実行停止(states:StopExecution)とインスタンス終了権限が付与されている(Issue #59)", () => {
    // DescribeExecutionも必須。ジョブのstatusは「実行が終わったか」の代理条件に
    // ならない（ワーカーがSendTaskFailureより先にfailedを書く）ため、停止可否は
    // 実行の生死を直接問い合わせて判定している。
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ["states:StopExecution", "states:DescribeExecution"],
          }),
        ]),
      },
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            // DescribeInstancesは孤児インスタンスをタグから探すため（instanceIdは
            // CreateFleetの後に書かれるので、起動直後の停止では未記録でありうる）。
            Action: ["ec2:TerminateInstances", "ec2:DescribeInstances"],
            Resource: "*",
          }),
        ]),
      },
    });
  });

  it("再実行Lambdaに元ジョブの実行状態確認(states:DescribeExecution)権限が付与されている(Issue #59)", () => {
    // statusがfailedでもリトライループの最中でありうるため、複製前に実行の生死を
    // 確認して二重録画（EC2の二重課金）を防いでいる。
    const policies = template.findResources("AWS::IAM::Policy", {
      Properties: {
        PolicyDocument: {
          Statement: Match.arrayWith([Match.objectLike({ Action: "states:StartExecution" })]),
        },
      },
    });
    const retryPolicy = Object.entries(policies).find(([logicalId]) =>
      logicalId.startsWith("AdminRetryJobFn"),
    );
    expect(retryPolicy, "AdminRetryJobFnのポリシーが見つからない").toBeTruthy();
    const statements = (
      retryPolicy?.[1] as { Properties: { PolicyDocument: { Statement: { Action: unknown }[] } } }
    ).Properties.PolicyDocument.Statement;
    expect(statements.some((statement) => statement.Action === "states:DescribeExecution")).toBe(
      true,
    );
  });

  it("管理画面用Lambda Authorizerがsimple response形式で定義されている", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      AuthorizerType: "REQUEST",
      AuthorizerPayloadFormatVersion: "2.0",
      EnableSimpleResponses: true,
      IdentitySource: ["$request.header.Authorization"],
      AuthorizerResultTtlInSeconds: 300,
    });
  });

  it("HTTP APIのCORSがAuthorizationヘッダーを許可している(管理画面のBearerトークン用)", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      CorsConfiguration: Match.objectLike({
        AllowHeaders: Match.arrayWith(["authorization"]),
      }),
    });
  });

  it("管理画面Authorizer LambdaにSSM読み取りとKMS復号権限が付与されている", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["ssm:GetParameter"]),
          }),
        ]),
      },
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "kms:Decrypt",
            Condition: { StringEquals: { "kms:ViaService": Match.anyValue() } },
          }),
        ]),
      },
    });
  });

  it("運用アラート用SNSトピックにメール購読が1件ある(Issue #135 OPS-3)", () => {
    template.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "email",
      Endpoint: "ops@example.com",
    });
  });

  it("RecordingStateMachineの実行失敗アラームがOPS-3で提案された閾値(1時間で3件)を持つ", () => {
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "AWS/States",
      MetricName: "ExecutionsFailed",
      Period: 3600,
      Threshold: 3,
    });
  });

  it("Lambdaのエラー・スロットルはFunctionNameディメンション無しのアカウント全体集計に1本ずつ張られている(Issue #154)", () => {
    // 個別関数ごとに張るとCloudWatch AlarmのFree Tier(10個/月)を大幅に超過するため
    // (Issue #154, docs/decisions/0027)、`AWS/Lambda`が自動公開するディメンション無し
    // の集計メトリクスに1本ずつ張る設計にした。特定の関数を指すDimensionsが付いて
    // いないことを確認する。
    const alarms = template.findResources("AWS::CloudWatch::Alarm");
    const errorAlarms = Object.values(alarms).filter(
      (alarm) => alarm.Properties?.MetricName === "Errors" && alarm.Properties?.Namespace === "AWS/Lambda",
    );
    const throttleAlarms = Object.values(alarms).filter(
      (alarm) =>
        alarm.Properties?.MetricName === "Throttles" && alarm.Properties?.Namespace === "AWS/Lambda",
    );
    expect(errorAlarms).toHaveLength(1);
    expect(throttleAlarms).toHaveLength(1);
    expect(errorAlarms[0]?.Properties?.Dimensions).toBeUndefined();
    expect(throttleAlarms[0]?.Properties?.Dimensions).toBeUndefined();
  });

  it("完了メール送信失敗のメトリクスフィルタとアラームが存在する(Issue #135 OPS-3)", () => {
    template.hasResourceProperties("AWS::Logs::MetricFilter", {
      FilterPattern: '{ $.event = "send_completion_email_failed" }',
      MetricTransformations: Match.arrayWith([
        Match.objectLike({ MetricNamespace: "Sattori", MetricName: "SendCompletionEmailFailed" }),
      ]),
    });
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "Sattori",
      MetricName: "SendCompletionEmailFailed",
      Threshold: 1,
    });
  });
});
