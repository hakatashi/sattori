import type { HistoryEvent } from "@aws-sdk/client-sfn";
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
