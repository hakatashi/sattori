import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { StartJob } from "../components/StartJob.tsx";
import { JobProgress } from "../components/JobProgress.tsx";
import { useLocale } from "../i18n/LocaleContext.ts";
import { toLocalizedPath } from "../i18n/paths.ts";

/**
 * ページB（`/jobs/{jobId}`, マジックリンクのメールから開く）。
 * jobIdはメールを確認しないと分からない秘密値として機能するため、URLには
 * jobId以外の認可情報（token等）は含まない（Issue #9）。ジョブの永続ビューとして、
 * 何度アクセスしても現在の進捗・DLに戻れる（Issue #10）。
 */
export function JobPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const lang = useLocale();
  const [started, setStarted] = useState(false);

  // ページBからページAへ戻る際は現在の言語のホームへ遷移する。
  const resetToUpload = () => navigate(toLocalizedPath("/", lang));

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
