import { beforeEach, describe, expect, it, vi } from "vitest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { GetJobResponse, JobRecord, ReplayInfo } from "@sattori/shared";
import { createJobRecord } from "../testSupport/jobRecord.js";

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
  ANALYTICS_EVENTS_TABLE: "sattori-analytics-events",
};

const ddbMock = mockClient(DynamoDBDocumentClient);

const REPLAY_INFO: ReplayInfo = {
  game: "th11",
  player: "koyi",
  date: "01/18",
  character: "霊夢A",
  characterNameJa: null,
  characterNameEn: null,
  difficulty: "Lunatic",
  stage: null,
  score: 442469780,
  cleared: true,
  estimatedDurationSeconds: 847,
};

const doneJob: JobRecord = createJobRecord({
  game: "th11",
  status: "done",
  outputPath: "output/job-1/video.mp4",
  outputPath720p: "output/job-1/video-720p.mp4",
  doneAt: "2026-07-18T00:00:00.000Z",
  instanceId: "i-1234",
  instanceType: "c7i.2xlarge",
  availabilityZone: "us-east-1a",
  replayInfo: REPLAY_INFO,
});

function makeEvent(jobId: string): APIGatewayProxyEventV2 {
  return { pathParameters: { jobId } } as unknown as APIGatewayProxyEventV2;
}

function parseBody(res: APIGatewayProxyStructuredResultV2): GetJobResponse {
  return JSON.parse(res.body ?? "{}") as GetJobResponse;
}

describe("GET /jobs/{jobId}", () => {
  beforeEach(() => {
    ddbMock.reset();
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      vi.stubEnv(key, value);
    }
  });

  it("完了ジョブは response-content-disposition クエリ付きのダウンロードURLを返す(ブラウザ標準のダウンロード機構を使わせるため)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: doneJob });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.downloadUrl720p).toBeTruthy();
    const url720p = new URL(body.downloadUrl720p as string);
    expect(url720p.origin + url720p.pathname).toBe(
      "https://cdn.example.net/output/job-1/video-720p.mp4",
    );
    const disposition720p = url720p.searchParams.get("response-content-disposition");
    expect(disposition720p).toContain("attachment;");
    expect(disposition720p).toContain(
      "filename*=UTF-8''%E6%9D%B1%E6%96%B9%E5%9C%B0%E9%9C%8A%E6%AE%BF",
    );

    expect(body.downloadUrl).toBeTruthy();
    const urlOriginal = new URL(body.downloadUrl as string);
    expect(urlOriginal.origin + urlOriginal.pathname).toBe(
      "https://cdn.example.net/output/job-1/video.mp4",
    );
    // 720p版とオリジナル解像度版はファイル名(disposition)で区別できる。
    expect(urlOriginal.searchParams.get("response-content-disposition")).not.toBe(disposition720p);
  });

  it("完了ジョブは doneAt + OUTPUT_RETENTION_DAYS(7日) をダウンロード期限として返す", async () => {
    ddbMock.on(GetCommand).resolves({ Item: doneJob });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.downloadExpiresAt).toBe("2026-07-25T00:00:00.000Z");
  });

  it("doneAt未設定の旧ジョブはダウンロード期限を返さない", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...doneJob, doneAt: null } });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.downloadExpiresAt).toBeNull();
  });

  it("録画中(done以外)のジョブはダウンロードURL・期限を返さない", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...doneJob, status: "recording" } });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.downloadUrl).toBeNull();
    expect(body.downloadUrl720p).toBeNull();
    expect(body.downloadExpiresAt).toBeNull();
  });

  it("完了ジョブは response-content-disposition を付けない720p版のプレビュー再生URLを返す", async () => {
    ddbMock.on(GetCommand).resolves({ Item: doneJob });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    // `<video src>`にそのまま渡すURL。dispositionを付けるとCloudFrontのキャッシュキーが
    // ダウンロード用と分かれてしまうため、クエリなしの素のCDN URLであることを保証する。
    expect(body.previewVideoUrl).toBe("https://cdn.example.net/output/job-1/video-720p.mp4");
  });

  it("720p版が無い完了ジョブのプレビュー再生URLは元解像度版へフォールバックする", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...doneJob, outputPath720p: null } });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.previewVideoUrl).toBe("https://cdn.example.net/output/job-1/video.mp4");
  });

  it("録画中(done以外)のジョブはプレビュー再生URLを返さない", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...doneJob, status: "recording" } });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.previewVideoUrl).toBeNull();
  });

  it("完了ジョブもプレビュー画像URLを返す(プレビュープレイヤーのposterに使う)", async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { ...doneJob, previewImagePath: "previews/job-1/latest.jpg" } });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.previewImageUrl).toBe("https://cdn.example.net/previews/job-1/latest.jpg");
  });

  it("完了ジョブはposterImagePathからposterImageUrlを返す(Issue #171)", async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { ...doneJob, posterImagePath: "videos/job-1_poster.jpg" } });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.posterImageUrl).toBe("https://cdn.example.net/videos/job-1_poster.jpg");
  });

  it("poster抽出に失敗した(posterImagePathが無い)完了ジョブはposterImageUrl:nullを返す", async () => {
    ddbMock.on(GetCommand).resolves({ Item: doneJob });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.posterImageUrl).toBeNull();
  });

  it("録画中(done以外)のジョブはposterImagePathがあってもposterImageUrlを返さない", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...doneJob, status: "converting", posterImagePath: "videos/job-1_poster.jpg" },
    });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.posterImageUrl).toBeNull();
  });

  it("失敗したジョブはプレビュー画像URLを返さない", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...doneJob, status: "failed", previewImagePath: "previews/job-1/latest.jpg" },
    });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.previewImageUrl).toBeNull();
    expect(body.previewVideoUrl).toBeNull();
  });

  it("失敗したジョブは error と errorCode をそのまま返す", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        ...doneJob,
        status: "failed",
        error: "録画に複数回失敗しました。時間をおいて再試行してください",
        errorCode: "retries_exhausted",
      },
    });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.error).toBe("録画に複数回失敗しました。時間をおいて再試行してください");
    expect(body.errorCode).toBe("retries_exhausted");
  });

  it("errorCode未設定の旧ジョブ（DynamoDB上に属性自体が無い）ではnullを返す", async () => {
    const { errorCode: _omit, ...legacyItem } = doneJob;
    ddbMock.on(GetCommand).resolves({
      Item: { ...legacyItem, status: "failed", error: "録画処理中にエラーが発生しました" },
    });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.errorCode).toBeNull();
  });

  it("リプレイずれが検知されたジョブは desyncDetected:true を返す(Issue #103)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...doneJob, desyncDetected: true } });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.desyncDetected).toBe(true);
  });

  it("desyncDetected未設定の旧ジョブ（DynamoDB上に属性自体が無い）ではnullを返す", async () => {
    const { desyncDetected: _omit, ...legacyItem } = doneJob;
    ddbMock.on(GetCommand).resolves({ Item: legacyItem });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.desyncDetected).toBeNull();
  });

  it("タイムアウト打ち切りのジョブは timedOut:true を返す(Issue #161)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...doneJob, timedOut: true } });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.timedOut).toBe(true);
  });

  it("timedOut未設定の旧ジョブ（DynamoDB上に属性自体が無い）ではnullを返す", async () => {
    const { timedOut: _omit, ...legacyItem } = doneJob;
    ddbMock.on(GetCommand).resolves({ Item: legacyItem });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.timedOut).toBeNull();
  });

  it("ジョブが存在しなければ404を返す", async () => {
    ddbMock.on(GetCommand).resolves({});
    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("missing"), {} as never, () => {});
    expect((res as APIGatewayProxyStructuredResultV2).statusCode).toBe(404);
  });

  /**
   * 低速録画（Issue #68）。`slowMotion` はユーザーの希望そのままではなく、
   * EC2 へフォールバックしたかどうかまで織り込んだ「実際に低速録画で走るか」。
   * ジョブページの残り時間推定がこの値で2倍のバジェットを取る。
   */
  it("自宅ワーカーが引き受けた低速録画ジョブは slowMotion:true を返す", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...doneJob, options: { watermark: true, slowMotion: true }, workerKind: "home" },
    });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});

    expect(parseBody(res as APIGatewayProxyStructuredResultV2).slowMotion).toBe(true);
  });

  it("EC2へフォールバックしたジョブは、希望されていても slowMotion:false を返す", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...doneJob, options: { watermark: true, slowMotion: true }, workerKind: "ec2" },
    });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});

    expect(parseBody(res as APIGatewayProxyStructuredResultV2).slowMotion).toBe(false);
  });

  it("低速録画を希望していないジョブは常に slowMotion:false を返す", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...doneJob, workerKind: "home" } });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});

    expect(parseBody(res as APIGatewayProxyStructuredResultV2).slowMotion).toBe(false);
  });

  /**
   * 出力が1本のジョブ（th20・低速録画。`worker/convert.py` の
   * `needs_separate_raw_output()` 参照）。`outputPath` が指すのは録画そのままの
   * 副次版ではなく**変換結果そのもの**なので、ファイル名に ` #raw` を付けてはいけない。
   */
  it("720p版が無いジョブは outputPath を本命として扱い、ファイル名に #raw を付けない", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...doneJob, outputPath: "output/job-1/video-720p.mp4", outputPath720p: null },
    });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    expect(body.downloadUrl720p).toBeNull();
    expect(body.downloadUrl).toBeTruthy();
    const disposition = new URL(body.downloadUrl as string).searchParams.get(
      "response-content-disposition",
    );
    expect(disposition).not.toContain("raw");
  });

  it("720p版があるジョブでは outputPath 側のファイル名に #raw が付く", async () => {
    ddbMock.on(GetCommand).resolves({ Item: doneJob });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});
    const body = parseBody(res as APIGatewayProxyStructuredResultV2);

    const disposition = new URL(body.downloadUrl as string).searchParams.get(
      "response-content-disposition",
    );
    expect(disposition).toContain("raw");
  });

  it("720p版が無くてもプレビュー再生URLは outputPath へフォールバックする", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...doneJob, outputPath: "output/job-1/video-720p.mp4", outputPath720p: null },
    });

    const { handler } = await import("./getJob.js");
    const res = await handler(makeEvent("job-1"), {} as never, () => {});

    expect(parseBody(res as APIGatewayProxyStructuredResultV2).previewVideoUrl).toBe(
      "https://cdn.example.net/output/job-1/video-720p.mp4",
    );
  });
});
