import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import type { ApiError } from "@sattori/shared";

/** API Gateway HTTP API（payload v2）用の JSON レスポンスを組み立てる。 */
export function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  };
}

export function error(statusCode: number, code: string, message: string): APIGatewayProxyStructuredResultV2 {
  const body: ApiError = { code, message };
  return json(statusCode, body);
}

/** リクエストボディを JSON としてパースする。失敗時は null。 */
export function parseBody<T>(event: APIGatewayProxyEventV2): T | null {
  if (!event.body) {
    return null;
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf-8")
    : event.body;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
