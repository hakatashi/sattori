import { useEffect, useState } from "react";
import { isTerminalStatus, type GetJobResponse } from "@sattori/shared";
import { getJob } from "../api/client.ts";

const POLL_INTERVAL_MS = 3000;

export interface JobPollingState {
  job: GetJobResponse | null;
  loadError: string | null;
}

/**
 * ジョブが終端状態（done/failed）になるまで一定間隔でポーリングする。
 * 月1000回規模では WebSocket/SSE は過剰なため単純ポーリングで十分（設計方針）。
 */
export function useJobPolling(jobId: string): JobPollingState {
  const [job, setJob] = useState<GetJobResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const next = await getJob(jobId);
        if (cancelled) {
          return;
        }
        setJob(next);
        setLoadError(null);
        if (!isTerminalStatus(next.status)) {
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch {
        if (cancelled) {
          return;
        }
        setLoadError("状態の取得に失敗しました。再試行します…");
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [jobId]);

  return { job, loadError };
}
