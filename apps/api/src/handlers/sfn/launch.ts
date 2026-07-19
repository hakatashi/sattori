import { loadConfig } from "../../config.js";
import { launchRecordingInstance } from "../../ec2.js";
import { getJob, updateJobInstanceId, updateJobStatus } from "../../jobs.js";

/**
 * Step Functions の `Launch` ステート（`waitForTaskToken` パターン）から呼ばれる Lambda。
 * EC2 Fleet でワーカーインスタンスを起動するだけで、成功/失敗の確定はワーカー自身が
 * `taskToken` 経由で `SendTaskSuccess`/`SendTaskFailure` を呼ぶことで行う
 * （このハンドラの戻り値は Step Functions の実行結果に影響しない）。
 * インスタンス起動自体が失敗した場合は例外を投げ、ステートマシンの Catch に委ねる。
 */
export interface LaunchTaskEvent {
  jobId: string;
  /** 何回目の起動試行か（1始まり）。ログ・診断用。 */
  attempt: number;
  /** Step Functions が発行した `waitForTaskToken` のトークン。 */
  taskToken: string;
}

export const handler = async (event: LaunchTaskEvent): Promise<void> => {
  const config = loadConfig();
  const job = await getJob(config.jobsTable, event.jobId);
  if (!job) {
    throw new Error(`ジョブが見つかりません: ${event.jobId}`);
  }

  console.log(
    JSON.stringify({ event: "launch_attempt", jobId: event.jobId, attempt: event.attempt }),
  );

  const instanceId = await launchRecordingInstance(config, job, event.taskToken);
  await updateJobStatus(config.jobsTable, event.jobId, "launching");
  await updateJobInstanceId(config.jobsTable, event.jobId, instanceId);
};
