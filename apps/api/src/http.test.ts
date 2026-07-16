import { describe, expect, it } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { error, json, parseBody } from "./http.js";

function makeEvent(body: string | undefined, isBase64 = false): APIGatewayProxyEventV2 {
  return { body, isBase64Encoded: isBase64 } as APIGatewayProxyEventV2;
}

describe("http", () => {
  it("json は content-type 付きの応答を返す", () => {
    const res = json(200, { ok: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers?.["content-type"]).toContain("application/json");
    expect(res.body).toBe('{"ok":true}');
  });

  it("error は ApiError 形式を返す", () => {
    const res = error(404, "not_found", "見つかりません");
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body ?? "{}")).toEqual({ code: "not_found", message: "見つかりません" });
  });

  it("parseBody は JSON をパースする", () => {
    expect(parseBody(makeEvent('{"a":1}'))).toEqual({ a: 1 });
  });

  it("parseBody は base64 ボディを復号する", () => {
    const encoded = Buffer.from('{"a":2}', "utf-8").toString("base64");
    expect(parseBody(makeEvent(encoded, true))).toEqual({ a: 2 });
  });

  it("parseBody は不正な JSON / 空ボディで null を返す", () => {
    expect(parseBody(makeEvent("not json"))).toBeNull();
    expect(parseBody(makeEvent(undefined))).toBeNull();
  });
});
