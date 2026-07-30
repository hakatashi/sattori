import { beforeEach, describe, expect, it, vi } from "vitest";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import type { ReplayInfo } from "@sattori/shared";

const s3Mock = mockClient(S3Client);

const REPLAY_INFO: ReplayInfo = {
  game: "th11",
  player: "koyi",
  date: "01/18",
  character: "霊夢A",
  difficulty: "Lunatic",
  stage: null,
  score: 442469780,
  cleared: true,
  estimatedDurationSeconds: 847,
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
      "cdn.example.net",
      "videos/job-1_720p.mp4",
      { jobId: "job-1", replayInfo: REPLAY_INFO },
      "720p",
    );
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://cdn.example.net/videos/job-1_720p.mp4");
    expect(parsed.searchParams.get("response-content-disposition")).toContain("attachment;");
  });

  it("buildCdnUrl: CloudFront配信URLを組み立てる", async () => {
    const { buildCdnUrl } = await import("./downloads.js");
    expect(buildCdnUrl("cdn.example.net", "progress/job-1/123.jpg")).toBe(
      "https://cdn.example.net/progress/job-1/123.jpg",
    );
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
});
