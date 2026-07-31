import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";

const ssmMock = mockClient(SSMClient);

describe("adminAuth", () => {
  beforeEach(() => {
    ssmMock.reset();
    vi.stubEnv("ADMIN_TOKEN_PARAMETER_NAME", "/sattori/admin/token");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("extractBearerToken: Authorization: Bearer <token> からトークンを取り出す", async () => {
    const { extractBearerToken } = await import("./adminAuth.js");
    expect(extractBearerToken({ authorization: "Bearer abc123" })).toBe("abc123");
    // schemeの大文字小文字は区別しない
    expect(extractBearerToken({ authorization: "bearer abc123" })).toBe("abc123");
    // API Gatewayはヘッダーキーを小文字化するが、念のため大文字キーも許容する
    expect(extractBearerToken({ Authorization: "Bearer abc123" })).toBe("abc123");
  });

  it("extractBearerToken: ヘッダーが無い・Bearerでない場合は null", async () => {
    const { extractBearerToken } = await import("./adminAuth.js");
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken({})).toBeNull();
    expect(extractBearerToken({ authorization: "Basic abc123" })).toBeNull();
    expect(extractBearerToken({ authorization: "Bearer " })).toBeNull();
  });

  it("isValidAdminToken: SSMの値と一致すればtrue、不一致ならfalse", async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: "correct-token" } });
    const { isValidAdminToken, resetAdminTokenCache } = await import("./adminAuth.js");
    resetAdminTokenCache();

    expect(await isValidAdminToken("correct-token")).toBe(true);
    expect(await isValidAdminToken("wrong-token")).toBe(false);
    // 長さが異なる場合もRangeErrorを投げずfalseになる(SHA-256経由の固定長比較)
    expect(await isValidAdminToken("short")).toBe(false);
  });

  it("isValidAdminToken: presentedがnullならSSMを呼ばずfalse", async () => {
    const { isValidAdminToken, resetAdminTokenCache } = await import("./adminAuth.js");
    resetAdminTokenCache();

    expect(await isValidAdminToken(null)).toBe(false);
    expect(ssmMock.calls().length).toBe(0);
  });

  it("isValidAdminToken: SSM取得結果はキャッシュされ、TTL内は再取得しない", async () => {
    vi.useFakeTimers();
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: "correct-token" } });
    const { isValidAdminToken, resetAdminTokenCache, ADMIN_TOKEN_CACHE_TTL_MS } = await import(
      "./adminAuth.js"
    );
    resetAdminTokenCache();

    expect(await isValidAdminToken("correct-token")).toBe(true);
    expect(await isValidAdminToken("correct-token")).toBe(true);
    expect(ssmMock.calls().length).toBe(1);

    // TTL経過後は再取得する
    vi.advanceTimersByTime(ADMIN_TOKEN_CACHE_TTL_MS + 1);
    expect(await isValidAdminToken("correct-token")).toBe(true);
    expect(ssmMock.calls().length).toBe(2);
  });

  it("isValidAdminToken: SSM呼び出しが失敗しても例外を投げずfalseを返す", async () => {
    ssmMock.on(GetParameterCommand).rejects(new Error("AccessDenied"));
    const { isValidAdminToken, resetAdminTokenCache } = await import("./adminAuth.js");
    resetAdminTokenCache();

    await expect(isValidAdminToken("anything")).resolves.toBe(false);
  });

  it("isValidAdminToken: SSMにパラメータが存在しない(Valueが空)場合もfalse", async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: {} });
    const { isValidAdminToken, resetAdminTokenCache } = await import("./adminAuth.js");
    resetAdminTokenCache();

    await expect(isValidAdminToken("anything")).resolves.toBe(false);
  });
});
