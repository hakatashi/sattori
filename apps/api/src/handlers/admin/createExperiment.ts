import { randomUUID } from "node:crypto";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { parseReplayInfo } from "@sattori/shared";
import type { AdminCreateExperimentResponse, GameId, JobRecord, ReplayInfo } from "@sattori/shared";
import { loadConfig, required } from "../../config.js";
import { objectExistsStrict } from "../../downloads.js";
import { buildExperimentJob, parseExperimentRequest } from "../../experiments.js";
import { error, json, parseBody } from "../../http.js";
import { getJob, putJob, updateJobStatus } from "../../jobs.js";
import { fetchReplayBytes, ReplayTooLargeError } from "../../replay.js";
import { INITIAL_ATTEMPT } from "../../retryPolicy.js";
import type { LaunchTaskEvent } from "../sfn/launch.js";

const sfn = new SFNClient({});

/**
 * POST /admin/experiments
 * 段を明示した録画ジョブ（実験ジョブ、Epic #399・Issue #397、`docs/decisions/0075`）を作って起動する。
 * 認可はAPI Gateway側のLambda Authorizerが担う。
 *
 * 作られるジョブは`experiment`を持つ以外は通常のジョブと同じ（`queued`で作ってStep Functionsを
 * 起動する。孤児掃除・コスト推定・ワーカーログ・進捗プレビューも共通）。完了メールは送らない
 * （`email`がnull）。マジックリンクのレート制限・月間コストガードは通らない（管理者専用のため）。
 * キルスイッチ（`SettingsTable`）は`Launch`側で効く。
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const config = loadConfig();
  const parsed = parseExperimentRequest(parseBody<unknown>(event), {
    primary: config.ec2.region,
    gpuFallback: config.ec2.gpuFallback?.region ?? null,
  });
  if (!parsed.ok) {
    return error(400, "invalid_request", parsed.message);
  }

  let game: GameId;
  let replayKey: string;
  let replayInfo: ReplayInfo | null;
  let estimatedDurationSeconds: number | null;
  if ("sourceJobId" in parsed.source) {
    const source = await getJob(config.jobsTable, parsed.source.sourceJobId);
    if (!source) {
      return error(404, "not_found", "sourceJobId のジョブが見つかりません");
    }
    game = source.game;
    replayKey = source.replayKey;
    replayInfo = source.replayInfo;
    estimatedDurationSeconds = source.estimatedDurationSeconds;
    // 元のリプレイが消えていれば録画は必ず失敗するので、起動前に弾く（`retryJob.ts`と同じ）。
    let exists: boolean;
    try {
      exists = await objectExistsStrict(config.uploadBucket, replayKey);
    } catch {
      return error(502, "replay_check_failed", "リプレイファイルの存在確認に失敗しました。時間をおいて再試行してください");
    }
    if (!exists) {
      return error(409, "replay_missing", "元のリプレイファイルが見つかりません（削除済みの可能性があります）");
    }
  } else {
    game = parsed.source.game;
    replayKey = parsed.source.replayKey;
    let data: Uint8Array;
    try {
      data = await fetchReplayBytes(config.uploadBucket, replayKey, config.maxReplayBytes);
    } catch (err) {
      if (err instanceof ReplayTooLargeError) {
        return error(413, "file_too_large", "リプレイファイルのサイズが上限を超えています");
      }
      return error(404, "replay_not_found", "アップロードされたリプレイファイルが見つかりません");
    }
    const result = parseReplayInfo(data);
    if (!result.ok) {
      return error(422, result.error.code, result.error.message);
    }
    if (result.info.game !== game) {
      return error(
        400,
        "game_mismatch",
        `指定の game（${game}）とリプレイの判定結果（${result.info.game}）が一致しません`,
      );
    }
    replayInfo = result.info;
    estimatedDurationSeconds = result.info.estimatedDurationSeconds ?? null;
  }

  const jobId = randomUUID();
  const job: JobRecord = buildExperimentJob({
    jobId,
    now: new Date(),
    spec: parsed.spec,
    game,
    replayKey,
    replayInfo,
    estimatedDurationSeconds,
    options: parsed.options,
  });
  await putJob(config.jobsTable, job);

  try {
    const input: Pick<LaunchTaskEvent, "jobId" | "attempt"> = { jobId, attempt: INITIAL_ATTEMPT };
    await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: required("STATE_MACHINE_ARN"),
        name: jobId,
        input: JSON.stringify(input),
      }),
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "admin_experiment_start_execution_failed",
        jobId,
        name: err instanceof Error ? err.name : undefined,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    // 起動できなかったレコードを`queued`のまま残さない（`retryJob.ts`と同じ）。
    await updateJobStatus(config.jobsTable, jobId, "failed", "録画ワーカーの起動に失敗しました", {
      errorCode: "launch_failed",
    });
    return error(502, "launch_failed", "実験ジョブの起動に失敗しました。時間をおいて再試行してください");
  }

  console.log(
    JSON.stringify({
      event: "admin_experiment_created",
      jobId,
      game,
      stepId: parsed.spec.step.id,
      workerImageTag: parsed.spec.workerImageTag,
    }),
  );
  const response: AdminCreateExperimentResponse = { jobId, status: "queued", stepId: parsed.spec.step.id };
  return json(200, response);
};
