/**
 * `WorkersTable` へのハートビート送出（Issue #49）。
 *
 * AWS側（`apps/api/src/handlers/sfn/launch.ts`）は、ここに書かれた情報だけを見て
 * 「このジョブを自宅ワーカーへオファーする価値があるか」を判断する。**新鮮な
 * ハートビートが無ければオファー自体が行われない**ので、デーモンが落ちている
 * 平常時に録画開始が遅れることはない。
 *
 * 項目の意味は `@sattori/shared` の `WorkerHeartbeat` を参照（型定義が契約の本体で、
 * こちらはその書き手）。間隔・TTLの定数も同じく共有パッケージのものを使う
 * ——AWS側の鮮度判定（`WORKER_HEARTBEAT_FRESH_SECONDS` = 間隔の3倍）と
 * 独立に動かせてしまうと、書き手だけ遅くしてオファーが止まる事故になるため。
 */
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { WORKER_HEARTBEAT_TTL_SECONDS } from "@sattori/shared";
import type { WorkerHeartbeat } from "@sattori/shared";
import type { Config } from "./config.js";

export interface HeartbeatState {
  accepting: boolean;
  activeJobs: number;
  /** テスト用の固定時刻。 */
  now?: Date;
}

export function buildHeartbeat(config: Config, state: HeartbeatState): WorkerHeartbeat {
  const now = state.now ?? new Date();
  return {
    workerId: config.workerId,
    kind: "home",
    lastHeartbeatAt: now.toISOString(),
    accepting: state.accepting,
    activeJobs: state.activeJobs,
    maxConcurrency: config.maxConcurrency,
    supportedGames: [...config.supportedGames],
    capabilities: [...config.capabilities],
    ttl: Math.floor(now.getTime() / 1000) + WORKER_HEARTBEAT_TTL_SECONDS,
  };
}

/**
 * ハートビートを丸ごと上書きする（部分更新にしない）。
 *
 * 項目が増減してもレコードに古い値が残らないほうが安全で、1台ぶんの小さな
 * アイテムなので `PutItem` のコストも無視できる。
 */
export async function publishHeartbeat(
  client: DynamoDBDocumentClient,
  workersTable: string,
  config: Config,
  state: HeartbeatState,
): Promise<WorkerHeartbeat> {
  const item = buildHeartbeat(config, state);
  await client.send(new PutCommand({ TableName: workersTable, Item: item }));
  return item;
}
