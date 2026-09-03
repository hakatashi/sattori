import { DEFAULT_RECORDING_OPTIONS } from "@sattori/shared";
import type { JobRecord } from "@sattori/shared";

/**
 * テスト用の`JobRecord`デフォルト値。`JobRecord`に属性が増えるたびに
 * `apps/api/src/handlers/**\/*.test.ts`各所のリテラルを書き換える必要が
 * あった（Issue #188）ため、ここへ一本化した。テストごとに異なる属性だけを
 * `createJobRecord()`の引数で上書きする。
 */
const DEFAULT_JOB_RECORD: JobRecord = {
  jobId: "job-1",
  game: "th07",
  replayKey: "replays/abc.rpy",
  status: "pending",
  options: DEFAULT_RECORDING_OPTIONS,
  outputPath: null,
  outputPath720p: null,
  outputBytes: null,
  outputBytes720p: null,
  error: null,
  errorCode: null,
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
  launchedAt: null,
  doneAt: null,
  email: "user@example.com",
  pendingExpiresAt: "2099-01-01T00:00:00.000Z",
  instanceId: null,
  instanceType: null,
  availabilityZone: null,
  spotPricePerHour: null,
  estimatedDurationSeconds: 900,
  progress: null,
  previewImagePath: null,
  posterImagePath: null,
  replayInfo: null,
  retriedToJobId: null,
  retriedFromJobId: null,
  workerKind: null,
  language: "ja",
  desyncDetected: null,
  timedOut: null,
};

export function createJobRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return { ...DEFAULT_JOB_RECORD, ...overrides };
}
