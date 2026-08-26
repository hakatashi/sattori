import type { GetJobResponse, JobStatus, ReplayInfo } from "@sattori/shared";
import { JobProgressView } from "../components/JobProgress.tsx";

const SAMPLE_REPLAY_INFO: ReplayInfo = {
  game: "th07",
  player: "博麗霊夢",
  date: "2026/07/23 12:34:56",
  character: "霊夢A",
  characterNameJa: null,
  characterNameEn: null,
  difficulty: "Hard",
  stage: "Stage 6",
  score: 123456780,
  cleared: true,
  estimatedDurationSeconds: 1800,
};

const BASE: Omit<
  GetJobResponse,
  | "status"
  | "downloadUrl"
  | "downloadUrl720p"
  | "downloadExpiresAt"
  | "error"
  | "errorCode"
  | "progress"
  | "previewVideoUrl"
  | "previewImageUrl"
> = {
  jobId: "sample-job-id",
  game: "th07",
  updatedAt: new Date().toISOString(),
  replayInfo: SAMPLE_REPLAY_INFO,
  slowMotion: false,
  desyncDetected: null,
};

function buildJob(overrides: Partial<GetJobResponse> & { status: JobStatus }): GetJobResponse {
  return {
    ...BASE,
    downloadUrl: null,
    downloadUrl720p: null,
    downloadExpiresAt: null,
    error: null,
    errorCode: null,
    progress: null,
    previewVideoUrl: null,
    previewImageUrl: null,
    ...overrides,
  };
}

const SAMPLE_JOBS: { title: string; job: GetJobResponse | null; loadError?: string }[] = [
  { title: "status: pending", job: buildJob({ status: "pending" }) },
  { title: "status: queued", job: buildJob({ status: "queued" }) },
  { title: "status: launching", job: buildJob({ status: "launching" }) },
  {
    title: "status: recording（進捗・プレビュー画像あり）",
    job: buildJob({
      status: "recording",
      progress: 756, // 1800秒中756秒経過(42%相当)
      previewImageUrl: "https://placehold.co/640x480/222/fff?text=Recording",
    }),
  },
  {
    title: "status: converting（進捗あり）",
    job: buildJob({
      status: "converting",
      progress: 1404, // 1800秒中1404秒経過(78%相当)
      previewImageUrl: "https://placehold.co/640x480/222/fff?text=Converting",
    }),
  },
  {
    title: "status: done（720p・元解像度の両方あり、プレビュー付き）",
    job: buildJob({
      status: "done",
      downloadUrl: "https://example.com/sample.mp4",
      downloadUrl720p: "https://example.com/sample-720p.mp4",
      downloadExpiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
      // 実在しないURLだが、preload="none"のため再生ボタンを押すまで取得は走らず、
      // posterだけが表示される（レイアウト確認にはこれで十分）。
      previewVideoUrl: "https://example.com/sample-720p.mp4",
      previewImageUrl: "https://placehold.co/640x480/222/fff?text=Preview",
    }),
  },
  {
    title: "status: done（プレビュー画像が無くposterが付かない場合）",
    job: buildJob({
      status: "done",
      downloadUrl: "https://example.com/sample.mp4",
      downloadUrl720p: "https://example.com/sample-720p.mp4",
      downloadExpiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
      previewVideoUrl: "https://example.com/sample-720p.mp4",
    }),
  },
  {
    title: "status: done（リプレイずれの疑いあり、Issue #103）",
    job: buildJob({
      status: "done",
      downloadUrl: "https://example.com/sample.mp4",
      downloadUrl720p: "https://example.com/sample-720p.mp4",
      downloadExpiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
      previewVideoUrl: "https://example.com/sample-720p.mp4",
      previewImageUrl: "https://placehold.co/640x480/222/fff?text=Preview",
      desyncDetected: true,
    }),
  },
  {
    title: "status: failed（errorCode無し・旧ジョブ、生文言をそのまま表示）",
    job: buildJob({
      status: "failed",
      error: "Spotインスタンスの中断が続いたため録画に失敗しました。",
    }),
  },
  {
    title: "status: failed（errorCodeあり、errors.<code>翻訳経由で表示）",
    job: buildJob({
      status: "failed",
      error: "録画に複数回失敗しました。時間をおいて再試行してください",
      errorCode: "retries_exhausted",
    }),
  },
  {
    title: "初回読み込み中（jobがまだ無い）",
    job: null,
  },
  {
    title: "ポーリングエラー",
    job: buildJob({ status: "recording", progress: 180 }),
    loadError: "状態の取得に失敗しました。再試行します…",
  },
  {
    title: "status: recording（replayInfo無し・旧ジョブ、割合表示なしで経過秒数のみ）",
    job: buildJob({ status: "recording", progress: 96, replayInfo: null }),
  },
];

/**
 * `pnpm dev` で `?preview=job` を付けて開くと、実際のジョブ起動・ポーリングを
 * 経由せずに JobProgress の各状態をまとめて確認できる
 * （デザイン調整用。App.tsx 側で import.meta.env.DEV ガード済みのため本番ビルドには含まれない）。
 */
export function JobProgressPlayground() {
  return (
    <div style={{ maxWidth: "90rem", margin: "0 auto", padding: "2rem", display: "flex", flexDirection: "column", gap: "2rem" }}>
      {SAMPLE_JOBS.map(({ title, job, loadError }) => (
        <section key={title}>
          <h2>{title}</h2>
          <JobProgressView job={job} loadError={loadError ?? null} />
        </section>
      ))}
    </div>
  );
}
