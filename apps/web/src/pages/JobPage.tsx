import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { StartJob } from "../components/StartJob.tsx";
import { JobProgress } from "../components/JobProgress.tsx";

/**
 * ページB（`/jobs/{jobId}`, マジックリンクのメールから開く）。
 * jobIdはメールを確認しないと分からない秘密値として機能するため、URLには
 * jobId以外の認可情報（token等）は含まない（Issue #9）。ジョブの永続ビューとして、
 * 何度アクセスしても現在の進捗・DLに戻れる（Issue #10）。
 */
export function JobPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const [started, setStarted] = useState(false);

  // ページBからページAへ戻る際は"/"へ遷移する。
  const resetToUpload = () => navigate("/");

  if (!jobId) {
    return null;
  }

  if (started) {
    return <JobProgress jobId={jobId} />;
  }

  return (
    <StartJob jobId={jobId} onStarted={() => setStarted(true)} onReset={resetToUpload} />
  );
}
