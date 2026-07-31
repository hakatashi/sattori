import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import {
  CloudWatchLogsClient,
  GetLogEventsCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-cloudwatch-logs";
import { EC2Client, GetConsoleOutputCommand } from "@aws-sdk/client-ec2";
import type { AdminLogsResponse } from "@sattori/shared";
import { required } from "../../config.js";
import { error, json } from "../../http.js";

const logs = new CloudWatchLogsClient({});
const ec2 = new EC2Client({});

/** 1リクエストあたりの取得件数。管理画面での目視確認用途のため大きくしすぎない。 */
const LOG_EVENTS_LIMIT = 500;

/**
 * ログストリーム(=jobId)が見つからない場合のフォールバック。UserData(bootstrap)段階の
 * 失敗（ECRログイン/pull失敗等）はコンテナが一度も起動せずawslogsドライバに乗らないため、
 * EC2インスタンス自体のコンソール出力を代わりに表示する（`apps/api/src/ec2.ts`のUserData
 * 内`trap`コメント、AGENTS.md参照）。インスタンスが既に終了している場合は取得できず
 * `Output`が空になりうるが、その場合は素直にnullへ縮退させる（500にしない）。
 */
async function tryGetConsoleOutput(instanceId: string): Promise<string | null> {
  try {
    const result = await ec2.send(new GetConsoleOutputCommand({ InstanceId: instanceId }));
    if (!result.Output) {
      return null;
    }
    return Buffer.from(result.Output, "base64").toString("utf-8");
  } catch (err) {
    console.error("GetConsoleOutput failed", { instanceId, error: err });
    return null;
  }
}

/**
 * GET /admin/jobs/{jobId}/logs
 * ワーカーコンテナのCloudWatch Logs（ロググループ`/sattori/worker`、ログストリーム名=jobId）
 * を新しい方から`GetLogEvents`でページングして返す（管理画面。Issue #58）。
 *
 * `instanceId`はDynamoDB(JobRecord)に持つ情報だが、このLambdaにはあえて
 * `jobsTable`読み取り権限を持たせない（`getExecution.ts`と同じ最小権限の考え方）。
 * 呼び出し元（フロント）は既に`GET /admin/jobs/{jobId}`で`job.instanceId`を持っているため、
 * ログストリームが見つからない場合のコンソール出力フォールバック用にクエリパラメータで渡す。
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const jobId = event.pathParameters?.jobId;
  if (!jobId) {
    return error(400, "invalid_request", "jobId が指定されていません");
  }

  const logGroupName = required("WORKER_LOG_GROUP");
  const cursor = event.queryStringParameters?.cursor;
  const instanceId = event.queryStringParameters?.instanceId;

  try {
    const result = await logs.send(
      new GetLogEventsCommand({
        logGroupName,
        logStreamName: jobId,
        nextToken: cursor,
        startFromHead: false,
        limit: LOG_EVENTS_LIMIT,
      }),
    );

    const events = (result.events ?? []).map((e) => ({
      timestamp: e.timestamp ?? null,
      message: e.message ?? "",
    }));
    // GetLogEventsは「これ以上古いイベントが無い」場合、渡したnextTokenと同じ
    // nextBackwardTokenを返す(AWS仕様)。取得0件の場合も含め、そこで打ち切りとみなす。
    const noMoreOlder = events.length === 0 || result.nextBackwardToken === cursor;

    const response: AdminLogsResponse = {
      logStreamFound: true,
      events,
      nextBackwardToken: noMoreOlder ? null : (result.nextBackwardToken ?? null),
      consoleOutput: null,
    };
    return json(200, response);
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      const consoleOutput = instanceId ? await tryGetConsoleOutput(instanceId) : null;
      const response: AdminLogsResponse = {
        logStreamFound: false,
        events: [],
        nextBackwardToken: null,
        consoleOutput,
      };
      return json(200, response);
    }
    throw err;
  }
};
