import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { isHeartbeatFresh, type GetWorkerAvailabilityResponse } from "@sattori/shared";
import type { WorkerCapability, WorkerHeartbeat } from "@sattori/shared";
import { loadConfig } from "../config.js";
import { listWorkerHeartbeats } from "../homeWorker.js";
import { json } from "../http.js";

/**
 * GET /worker-availability
 *
 * 常駐ワーカー（自宅ワーカー、Issue #49）が今この瞬間にジョブを引き受けられるかを返す。
 * ページAの詳細設定で「低速録画」（Issue #68）のチェックボックスを有効化してよいかの
 * 判定にだけ使う——低速録画は録画に実時間で倍かかるためEC2では行わず、自宅ワーカーが
 * いる場合に**限って**選べる、という要件をUIに反映するためのもの。
 *
 * `Launch` の `selectHomeWorker()` と判定を完全に一致させてはいない。あちらは
 * 「このジョブ（タイトル・要求能力）を任せられるか」まで見るが、こちらはリプレイの
 * 解析前——タイトルすら確定していない段階でも押さえておきたい情報なので、
 * **鮮度・受付意思・空きスロット**という、どのジョブにも共通する条件だけで判定し、
 * タイトル対応や能力は `capabilities` として呼び出し側へ渡して判断させる。
 *
 * 認証なしで公開されるため、`workerId`・台数・負荷といった開発者の自宅環境の
 * 運用情報は返さない（`GetWorkerAvailabilityResponse` のコメント参照）。
 */
function isAcceptingNow(worker: WorkerHeartbeat, now: Date): boolean {
  return (
    isHeartbeatFresh(worker, now) && worker.accepting && worker.activeJobs < worker.maxConcurrency
  );
}

export const handler: APIGatewayProxyHandlerV2 = async () => {
  const config = loadConfig();

  let workers: WorkerHeartbeat[];
  try {
    workers = await listWorkerHeartbeats(config.workersTable);
  } catch (err) {
    // ハートビートが読めないことでページAのアップロードそのものを止めない。
    // 「自宅ワーカーはいない」＝低速録画は選べない、という安全側の縮退で応答する。
    console.warn(
      JSON.stringify({
        event: "worker_availability_lookup_failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return json(200, { available: false, capabilities: [] } satisfies GetWorkerAvailabilityResponse);
  }

  const now = new Date();
  const accepting = workers.filter((worker) => isAcceptingNow(worker, now));
  const capabilities = [
    ...new Set(accepting.flatMap((worker) => worker.capabilities ?? [])),
  ] as WorkerCapability[];

  const response: GetWorkerAvailabilityResponse = {
    available: accepting.length > 0,
    capabilities,
  };
  return json(200, response);
};
