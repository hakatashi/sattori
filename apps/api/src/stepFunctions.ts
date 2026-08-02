import {
  DescribeExecutionCommand,
  ExecutionDoesNotExist,
  type HistoryEvent,
  type SFNClient,
} from "@aws-sdk/client-sfn";
import type { AdminExecutionEvent } from "@sattori/shared";

/**
 * ジョブのStep Functions実行ARNを組み立てる（Issue #51、管理画面用）。
 * `startJob.ts`が`StartExecutionCommand({ name: jobId, ... })`で実行名にjobIdを
 * そのまま使っているため、実行ARNは`executionArn`をDBに保存しなくても決定的に
 * 導出できる。ステートマシンARNの`:stateMachine:NAME`部分を`:execution:NAME:{jobId}`
 * に置き換える。
 */
export function buildExecutionArn(stateMachineArn: string, executionName: string): string {
  const parts = stateMachineArn.split(":");
  // arn:aws:states:{region}:{account}:stateMachine:{name}
  if (parts.length !== 7 || parts[5] !== "stateMachine") {
    throw new Error(`不正なステートマシンARNです: ${stateMachineArn}`);
  }
  parts[5] = "execution";
  parts.push(executionName);
  return parts.join(":");
}

/**
 * ジョブのStep Functions実行が今も動いているか。
 * - `running`: 実行中（`DescribeExecution`のstatusが`RUNNING`）。
 * - `finished`: 既に終了している（SUCCEEDED/FAILED/TIMED_OUT/ABORTED）。
 * - `absent`: 実行がそもそも存在しない（`pending`のまま起動していない、または
 *   Standard実行の履歴保持期間(90日)切れ）。
 */
export type ExecutionLiveness = "running" | "finished" | "absent";

/**
 * ジョブのStep Functions実行が生きているかを問い合わせる（Issue #59のレビュー指摘）。
 *
 * **`JobRecord.status`を「実行が終わったか」の代理条件にしてはならない**。ワーカーは
 * 内部エラー時に`SendTaskFailure`より先に`status: "failed"`を書き込み
 * （`worker/entrypoint.py`）、ステートマシンはその後`WaitBeforeCheck`(3分)を挟んで
 * `HandleFailure`へ進み、`attempt < MAX_ATTEMPTS`(10)なら`Launch`をやり直す
 * （`handlers/sfn/handleFailure.ts`は`status === "done"`のときしか中断しない）。
 * つまり**DynamoDB上は終端状態なのに実行は生きていて新しいインスタンスを起動し続ける**
 * 窓が毎回存在する。緊急停止の可否・再実行の可否はこの関数で判定する。
 *
 * 実行が存在しない場合のみ`absent`を返し、それ以外の失敗（スロットリング等）は
 * そのまま投げる（「判定不能」を呼び出し側が安全な側へ倒せるようにするため）。
 */
export async function getExecutionLiveness(
  sfn: SFNClient,
  executionArn: string,
): Promise<ExecutionLiveness> {
  try {
    const result = await sfn.send(new DescribeExecutionCommand({ executionArn }));
    return result.status === "RUNNING" ? "running" : "finished";
  } catch (err) {
    if (err instanceof ExecutionDoesNotExist) {
      return "absent";
    }
    throw err;
  }
}

/**
 * 生の`HistoryEvent`を管理画面向けに詰め替える。`*EventDetails`は40種類以上あり
 * 型も巨大なため、その時点で非nullだった詳細1つをキー名ごと落として抜き出す
 * 汎用関数にする（イベント種別が増えてもこの関数は変更不要）。
 */
export function toAdminExecutionEvent(event: HistoryEvent): AdminExecutionEvent {
  let details: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(event)) {
    if (key.endsWith("EventDetails") && value !== undefined) {
      details = value as Record<string, unknown>;
      break;
    }
  }

  return {
    id: event.id ?? 0,
    previousEventId: event.previousEventId ?? null,
    type: event.type ?? "Unknown",
    timestamp: event.timestamp ? event.timestamp.toISOString() : null,
    details,
  };
}
