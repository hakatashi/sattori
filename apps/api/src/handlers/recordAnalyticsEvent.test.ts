import { beforeEach, describe, expect, it, vi } from "vitest";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { ApiError, RecordAnalyticsEventResponse } from "@sattori/shared";

const ddbMock = mockClient(DynamoDBDocumentClient);

function event(
  body: unknown,
  headers: Record<string, string> = {},
  sourceIp = "203.0.113.1",
): APIGatewayProxyEventV2 {
  return {
    body: JSON.stringify(body),
    headers,
    requestContext: { http: { sourceIp } },
  } as unknown as APIGatewayProxyEventV2;
}

async function invoke(ev: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const { handler } = await import("./recordAnalyticsEvent.js");
  return (await handler(ev, {} as never, () => {})) as APIGatewayProxyStructuredResultV2;
}

describe("POST /beacon", () => {
  beforeEach(() => {
    vi.resetModules();
    ddbMock.reset();
    ddbMock.on(GetCommand).resolves({});
    vi.stubEnv("ANALYTICS_EVENTS_TABLE", "analytics-events");
    vi.stubEnv("SETTINGS_TABLE", "settings-table");
  });

  it("pageviewイベントをCloudFront-Viewer-Countryヘッダー付きで記録する", async () => {
    ddbMock.on(PutCommand).resolves({});

    const res = await invoke(
      event(
        {
          type: "pageview",
          path: "/",
          referrer: null,
          utmSource: null,
          utmMedium: null,
          utmCampaign: null,
          viewportWidth: 1280,
        },
        { "cloudfront-viewer-country": "JP", "accept-language": "ja-JP", "user-agent": "test-ua" },
      ),
    );

    expect(res.statusCode).toBe(202);
    const eventPut = ddbMock
      .commandCalls(PutCommand)
      .find((c) => c.args[0].input.TableName === "analytics-events");
    expect(eventPut?.args[0].input.Item).toMatchObject({ country: "JP", path: "/" });
  });

  it("CloudFront-Viewer-Countryヘッダーが無くても失敗しない(直接叩かれた場合)", async () => {
    ddbMock.on(PutCommand).resolves({});

    const res = await invoke(
      event({
        type: "parse_error",
        errorCode: "unsupported_game",
        game: "th09",
      }),
    );

    expect(res.statusCode).toBe(202);
    const eventPut = ddbMock
      .commandCalls(PutCommand)
      .find((c) => c.args[0].input.TableName === "analytics-events");
    expect(eventPut?.args[0].input.Item).toMatchObject({
      country: null,
      errorCode: "unsupported_game",
      game: "th09",
    });
  });

  it("sourceIpから日次saltでハッシュ化したvisitorHashを記録する（Issue #144）", async () => {
    ddbMock.on(PutCommand).resolves({});

    const res = await invoke(
      event(
        {
          type: "pageview",
          path: "/",
          referrer: null,
          utmSource: null,
          utmMedium: null,
          utmCampaign: null,
          viewportWidth: 1280,
        },
        { "x-forwarded-for": "198.51.100.7, 10.0.0.1" },
        "10.0.0.1",
      ),
    );

    expect(res.statusCode).toBe(202);
    const eventPut = ddbMock
      .commandCalls(PutCommand)
      .find((c) => c.args[0].input.TableName === "analytics-events");
    const item = eventPut?.args[0].input.Item as Record<string, unknown>;
    expect(typeof item.visitorHash).toBe("string");
    expect(JSON.stringify(item)).not.toContain("198.51.100.7");
  });

  it("不正な形のイベントは400を返しDynamoDBへ書かない", async () => {
    const res = await invoke(event({ type: "something_else" }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body ?? "{}") as ApiError).toMatchObject({ code: "invalid_analytics_event" });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("DynamoDBへの書き込みが失敗してもユーザーには202を返す(計測失敗でユーザー体験を壊さない)", async () => {
    ddbMock.on(PutCommand).rejects(new Error("throttled"));

    const res = await invoke(
      event({
        type: "pageview",
        path: "/",
        referrer: null,
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        viewportWidth: 1280,
      }),
    );

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body ?? "{}") as RecordAnalyticsEventResponse;
    expect(body).toEqual({});
  });
});
