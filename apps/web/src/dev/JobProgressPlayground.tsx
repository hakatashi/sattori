import type { GetJobResponse, JobStatus, ReplayInfo } from "@sattori/shared";
import { JobProgressView } from "../components/JobProgress.tsx";

const SAMPLE_REPLAY_INFO: ReplayInfo = {
  game: "th07",
  player: "博麗霊夢",
  date: "2026/07/23 12:34:56",
  character: "霊夢A",
  difficulty: "Hard",
  stage: "Stage 6",
  score: 123456780,
  cleared: true,
  estimatedDurationSeconds: 1800,
};

const BASE: Omit<GetJobResponse, "status" | "downloadUrl" | "downloadUrl720p" | "error" | "progress" | "previewImageUrl"> = {
  jobId: "sample-job-id",
  game: "th07",
  updatedAt: new Date().toISOString(),
  replayInfo: SAMPLE_REPLAY_INFO,
};

function buildJob(overrides: Partial<GetJobResponse> & { status: JobStatus }): GetJobResponse {
  return {
    ...BASE,
    downloadUrl: null,
    downloadUrl720p: null,
    error: null,
    progress: null,
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
      progress: 42,
      previewImageUrl: "https://placehold.co/640x480/222/fff?text=Recording",
    }),
  },
  {
    title: "status: converting（進捗あり）",
    job: buildJob({
      status: "converting",
      progress: 78,
      previewImageUrl: "https://placehold.co/640x480/222/fff?text=Converting",
    }),
  },
  {
    title: "status: done（720p・元解像度の両方あり）",
    job: buildJob({
      status: "done",
      downloadUrl: "https://example.com/sample.mp4",
      downloadUrl720p: "https://example.com/sample-720p.mp4",
    }),
  },
  {
    title: "status: failed",
    job: buildJob({
      status: "failed",
      error: "Spotインスタンスの中断が続いたため録画に失敗しました。",
    }),
  },
  {
    title: "初回読み込み中（jobがまだ無い）",
    job: null,
  },
  {
    title: "ポーリングエラー",
    job: buildJob({ status: "recording", progress: 10 }),
    loadError: "状態の取得に失敗しました。再試行します…",
  },
];

/**
 * `pnpm dev` で `?preview=job` を付けて開くと、実際のジョブ起動・ポーリングを
 * 経由せずに JobProgress の各状態をまとめて確認できる
 * （デザイン調整用。App.tsx 側で import.meta.env.DEV ガード済みのため本番ビルドには含まれない）。
 */
export function JobProgressPlayground() {
  return (
    <div style={{ maxWidth: "40rem", margin: "0 auto", padding: "2rem", display: "flex", flexDirection: "column", gap: "2rem" }}>
      {SAMPLE_JOBS.map(({ title, job, loadError }) => (
        <section key={title}>
          <h2>{title}</h2>
          <JobProgressView job={job} loadError={loadError ?? null} />
        </section>
      ))}
    </div>
  );
}
