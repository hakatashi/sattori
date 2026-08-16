import { beforeEach, describe, expect, it, vi } from "vitest";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { ApiError, RecordAnalyticsEventResponse } from "@sattori/shared";

const ddbMock = mockClient(DynamoDBDocumentClient);

function event(
  body: unknown,
  headers: Record<string, string> = {},
): APIGatewayProxyEventV2 {
  return {
    body: JSON.stringify(body),
    headers,
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
    vi.stubEnv("ANALYTICS_EVENTS_TABLE", "analytics-events");
  });

  it("pageviewイベントをCloudFront-Viewer-Countryヘッダー付きで記録する", async () => {
    ddbMock.on(PutCommand).resolvesOnce({});

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
    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input.Item).toMatchObject({ country: "JP", path: "/" });
  });

  it("CloudFront-Viewer-Countryヘッダーが無くても失敗しない(直接叩かれた場合)", async () => {
    ddbMock.on(PutCommand).resolvesOnce({});

    const res = await invoke(
      event({
        type: "parse_error",
        errorCode: "unsupported_game",
        game: "th09",
      }),
    );

    expect(res.statusCode).toBe(202);
    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item).toMatchObject({
      country: null,
      errorCode: "unsupported_game",
      game: "th09",
    });
  });

  it("不正な形のイベントは400を返しDynamoDBへ書かない", async () => {
    const res = await invoke(event({ type: "something_else" }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body ?? "{}") as ApiError).toMatchObject({ code: "invalid_analytics_event" });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("DynamoDBへの書き込みが失敗してもユーザーには202を返す(計測失敗でユーザー体験を壊さない)", async () => {
    ddbMock.on(PutCommand).rejectsOnce(new Error("throttled"));

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
