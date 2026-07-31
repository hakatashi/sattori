import { beforeEach, describe, expect, it, vi } from "vitest";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayRequestAuthorizerEventV2 } from "aws-lambda";

const ssmMock = mockClient(SSMClient);

function makeEvent(
  authorization: string | undefined,
): APIGatewayRequestAuthorizerEventV2 {
  return {
    version: "2.0",
    type: "REQUEST",
    routeArn: "arn:aws:execute-api:us-east-1:123456789012:abc123/$default/GET/admin/jobs",
    identitySource: authorization ? [authorization] : [],
    routeKey: "GET /admin/jobs",
    rawPath: "/admin/jobs",
    rawQueryString: "",
    cookies: [],
    headers: authorization ? { authorization } : {},
    requestContext: {} as APIGatewayRequestAuthorizerEventV2["requestContext"],
  };
}

describe("admin authorizer", () => {
  beforeEach(() => {
    ssmMock.reset();
    vi.stubEnv("ADMIN_TOKEN_PARAMETER_NAME", "/sattori/admin/token");
  });

  it("正しいトークンなら isAuthorized: true を返す", async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: "correct-token" } });
    const { resetAdminTokenCache } = await import("../../adminAuth.js");
    resetAdminTokenCache();
    const { handler } = await import("./authorizer.js");

    const result = await handler(makeEvent("Bearer correct-token"), {} as never, () => {});
    expect(result).toEqual({ isAuthorized: true });
  });

  it("誤ったトークンなら isAuthorized: false を返す", async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: "correct-token" } });
    const { resetAdminTokenCache } = await import("../../adminAuth.js");
    resetAdminTokenCache();
    const { handler } = await import("./authorizer.js");

    const result = await handler(makeEvent("Bearer wrong-token"), {} as never, () => {});
    expect(result).toEqual({ isAuthorized: false });
  });

  it("Authorizationヘッダーが無ければ isAuthorized: false を返す", async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: "correct-token" } });
    const { resetAdminTokenCache } = await import("../../adminAuth.js");
    resetAdminTokenCache();
    const { handler } = await import("./authorizer.js");

    const result = await handler(makeEvent(undefined), {} as never, () => {});
    expect(result).toEqual({ isAuthorized: false });
  });
});
