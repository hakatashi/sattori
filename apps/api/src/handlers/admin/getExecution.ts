import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import {
  DescribeExecutionCommand,
  ExecutionDoesNotExist,
  GetExecutionHistoryCommand,
  SFNClient,
} from "@aws-sdk/client-sfn";
import type { AdminExecutionResponse } from "@sattori/shared";
import { required } from "../../config.js";
import { error, json } from "../../http.js";
import { buildExecutionArn, toAdminExecutionEvent } from "../../stepFunctions.js";

const sfn = new SFNClient({});

/**
 * GET /admin/jobs/{jobId}/execution
 * ジョブに対応するStep Functions実行の状態・履歴を返す（管理画面。Issue #51）。
 * `GET /admin/jobs/{jobId}`とは別エンドポイントにしている理由:
 * (a) DescribeExecution/GetExecutionHistoryはDynamoDBとは別の失敗モード
 *     （`ExecutionDoesNotExist`・スロットリング・大きな履歴）を持ち、SFNが不調でも
 *     詳細画面はDynamoDB由来の情報だけで描画できるべき。
 * (b) 詳細用Lambdaに`states:*`権限を持たせずに済む（最小権限）。
 * 実行がまだ存在しない場合（statusがpendingのまま起動していない）や、Standard実行の
 * 履歴保持期間(90日)を過ぎている場合は 404 にはせず 200 + `execution: null` を返す
 * （ジョブ自体は存在し、実行だけが無い状態を素直に表現するため）。同じ理由で、
 * 履歴取得だけが失敗した場合も 500 にはせず `events: []` に縮退させる。
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const jobId = event.pathParameters?.jobId;
  if (!jobId) {
    return error(400, "invalid_request", "jobId が指定されていません");
  }

  const stateMachineArn = required("STATE_MACHINE_ARN");
  const executionArn = buildExecutionArn(stateMachineArn, jobId);

  try {
    // 履歴取得だけが失敗しても（スロットリング・巨大な履歴など）実行のstatus/error/cause
    // という調査で最も有用な情報は返せるべきなので、履歴側はallSettledで切り離して
    // 失敗時は events: [] に縮退させる。DescribeExecution自体の失敗は下のcatchへ流す
    // （`ExecutionDoesNotExist`の場合は両方が同じ理由でrejectする）。
    const [describeSettled, historySettled] = await Promise.allSettled([
      sfn.send(new DescribeExecutionCommand({ executionArn })),
      sfn.send(
        new GetExecutionHistoryCommand({ executionArn, maxResults: 100, reverseOrder: true }),
      ),
    ]);
    if (describeSettled.status === "rejected") {
      throw describeSettled.reason;
    }
    const describeResult = describeSettled.value;
    const historyResult = historySettled.status === "fulfilled" ? historySettled.value : null;
    if (historySettled.status === "rejected") {
      console.error("GetExecutionHistory failed; returning execution without events", {
        executionArn,
        error: historySettled.reason,
      });
    }

    const response: AdminExecutionResponse = {
      execution: {
        executionArn,
        status: describeResult.status ?? "UNKNOWN",
        startDate: describeResult.startDate ? describeResult.startDate.toISOString() : null,
        stopDate: describeResult.stopDate ? describeResult.stopDate.toISOString() : null,
        input: describeResult.input ?? null,
        output: describeResult.output ?? null,
        error: describeResult.error ?? null,
        cause: describeResult.cause ?? null,
      },
      events: (historyResult?.events ?? []).map(toAdminExecutionEvent),
      eventsNextToken: historyResult?.nextToken ?? null,
    };
    return json(200, response);
  } catch (err) {
    if (err instanceof ExecutionDoesNotExist) {
      const response: AdminExecutionResponse = {
        execution: null,
        events: [],
        eventsNextToken: null,
      };
      return json(200, response);
    }
    throw err;
  }
};
