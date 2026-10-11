import { beforeEach, describe, expect, it, vi } from "vitest";
import { HeadObjectCommand, NotFound, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import type { ReplayInfo } from "@sattori/shared";

const s3Mock = mockClient(S3Client);

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

const CDN = {
  domain: "cdn.example.net",
  primaryRegion: "eu-south-2",
  secondaryRegions: ["eu-north-1"],
};

describe("downloads", () => {
  beforeEach(() => {
    s3Mock.reset();
    // 署名計算はローカルで完結するためネットワークアクセスは発生しないが、
    // aws-sdk本体が資格情報プロバイダチェーンを呼び出さずに済むようダミー値を注入する。
    vi.stubEnv("AWS_ACCESS_KEY_ID", "dummy");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "dummy");
    vi.stubEnv("AWS_REGION", "us-east-1");
  });

  it("buildVideoDownloadUrl: response-content-dispositionクエリ付きのURLを組み立てる", async () => {
    const { buildVideoDownloadUrl } = await import("./downloads.js");
    const url = buildVideoDownloadUrl(
      CDN,
      "videos/job-1_720p.mp4",
      { jobId: "job-1", replayInfo: REPLAY_INFO },
      "delivery",
    );
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://cdn.example.net/videos/job-1_720p.mp4");
    expect(parsed.searchParams.get("response-content-disposition")).toContain("attachment;");
  });

  it("buildCdnUrl: CloudFront配信URLを組み立てる", async () => {
    const { buildCdnUrl } = await import("./downloads.js");
    expect(buildCdnUrl(CDN, undefined, "progress/job-1/123.jpg")).toBe(
      "https://cdn.example.net/progress/job-1/123.jpg",
    );
    expect(buildCdnUrl(CDN, "eu-south-2", "progress/job-1/123.jpg")).toBe(
      "https://cdn.example.net/progress/job-1/123.jpg",
    );
  });

  it("buildCdnUrl: 一次リージョン以外の出力は/<region>/を前置する(Issue #313)", async () => {
    const { buildCdnUrl } = await import("./downloads.js");
    expect(buildCdnUrl(CDN, "eu-north-1", "videos/job-1_poster.jpg")).toBe(
      "https://cdn.example.net/eu-north-1/videos/job-1_poster.jpg",
    );
  });

  it("buildCdnUrl: 配信先として知らないリージョンはプレフィックスを付けない", async () => {
    const { buildCdnUrl } = await import("./downloads.js");
    expect(buildCdnUrl(CDN, "../evil", "videos/job-1.mp4")).toBe(
      "https://cdn.example.net/videos/job-1.mp4",
    );
  });

  it("buildVideoDownloadUrl: outputRegionが一次以外ならパスに/<region>/を付ける(Issue #313)", async () => {
    const { buildVideoDownloadUrl } = await import("./downloads.js");
    const url = buildVideoDownloadUrl(
      CDN,
      "videos/job-1_720p.mp4",
      { jobId: "job-1", replayInfo: REPLAY_INFO, outputRegion: "eu-north-1" },
      "delivery",
    );
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/eu-north-1/videos/job-1_720p.mp4");
    expect(parsed.searchParams.get("response-content-disposition")).toContain("attachment;");
  });

  it("createPresignedFfmpegLogDownloadUrl: リージョンを渡すとそのリージョンのエンドポイントで署名する", async () => {
    const { createPresignedFfmpegLogDownloadUrl } = await import("./downloads.js");
    const url = await createPresignedFfmpegLogDownloadUrl(
      "out-eun1",
      "worker-logs/job-1/ffmpeg-upscale.log",
      "eu-north-1",
    );
    expect(new URL(url).host).toBe("out-eun1.s3.eu-north-1.amazonaws.com");
  });

  it("createPresignedReplayDownloadUrl: 署名クエリとContent-Dispositionを含むURLを返す", async () => {
    const { createPresignedReplayDownloadUrl } = await import("./downloads.js");
    const url = await createPresignedReplayDownloadUrl("up-bucket", "replays/job-1.rpy", "job-1.rpy");
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://up-bucket.s3.us-east-1.amazonaws.com/replays/job-1.rpy");
    expect(parsed.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(parsed.searchParams.get("response-content-disposition")).toContain("job-1.rpy");
  });

  it("objectExists: HeadObjectが成功すればtrue", async () => {
    s3Mock.on(HeadObjectCommand).resolves({});
    const { objectExists } = await import("./downloads.js");
    expect(await objectExists("up-bucket", "replays/job-1.rpy")).toBe(true);
  });

  it("objectExists: HeadObjectが失敗すればfalse(例外を投げない)", async () => {
    s3Mock.on(HeadObjectCommand).rejects(new Error("NotFound"));
    const { objectExists } = await import("./downloads.js");
    await expect(objectExists("up-bucket", "replays/missing.rpy")).resolves.toBe(false);
  });

  it("objectExistsStrict: 404はfalse", async () => {
    s3Mock.on(HeadObjectCommand).rejects(new NotFound({ message: "Not Found", $metadata: {} }));
    const { objectExistsStrict } = await import("./downloads.js");
    await expect(objectExistsStrict("up-bucket", "replays/missing.rpy")).resolves.toBe(false);
  });

  it("objectExistsStrict: httpStatusCode 404の汎用エラーもfalse", async () => {
    s3Mock
      .on(HeadObjectCommand)
      .rejects(Object.assign(new Error("NotFound"), { $metadata: { httpStatusCode: 404 } }));
    const { objectExistsStrict } = await import("./downloads.js");
    await expect(objectExistsStrict("up-bucket", "replays/missing.rpy")).resolves.toBe(false);
  });

  it("objectExistsStrict: 404以外の失敗はそのまま投げる(削除済みと誤断定しない)", async () => {
    s3Mock
      .on(HeadObjectCommand)
      .rejects(Object.assign(new Error("SlowDown"), { $metadata: { httpStatusCode: 503 } }));
    const { objectExistsStrict } = await import("./downloads.js");
    await expect(objectExistsStrict("up-bucket", "replays/job-1.rpy")).rejects.toThrow("SlowDown");
  });
});
