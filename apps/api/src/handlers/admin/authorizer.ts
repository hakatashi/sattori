import type { APIGatewayRequestSimpleAuthorizerHandlerV2 } from "aws-lambda";
import { extractBearerToken, isValidAdminToken } from "../../adminAuth.js";

/**
 * `/admin/*` 用のLambda Authorizer(REQUEST型・simple response)。
 * `Authorization: Bearer <token>` のトークンがSSMに登録された管理者トークンと
 * 一致するかだけを見る（1ユーザー固定のため、細かいIAMポリシー生成は不要。
 * `infra/lib/sattori-stack.ts` で `HttpLambdaResponseType.SIMPLE` を指定する）。
 * `identitySource`にAuthorizationヘッダーを指定しているため、ヘッダー自体が
 * 無いリクエストはAPI Gatewayがこのハンドラを起動せず401を返す。
 */
export const handler: APIGatewayRequestSimpleAuthorizerHandlerV2 = async (event) => {
  const token = extractBearerToken(event.headers);
  const isAuthorized = await isValidAdminToken(token);
  return { isAuthorized };
};
