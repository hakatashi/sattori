import type { ReplayInfo } from "@sattori/shared";
import { ReplayPreview } from "../components/ReplayPreview.tsx";

const SAMPLE_REPLAY_INFO: ReplayInfo = {
  game: "th07",
  player: "koyi",
  date: "01/18",
  character: "MarisaA",
  difficulty: "Extra",
  stage: null,
  score: 303766040,
  cleared: true,
  estimatedDurationSeconds: 847,
};

/**
 * `pnpm dev` で `?preview=replay` を付けて開くと、実際のアップロード・解析を
 * 経由せずに ReplayPreview の empty/loading/ready 状態をまとめて確認できる
 * （デザイン調整用。App.tsx 側で import.meta.env.DEV ガード済みのため本番ビルドには含まれない）。
 */
export function ReplayPreviewPlayground() {
  return (
    <div style={{ maxWidth: "40rem", margin: "0 auto", padding: "2rem", display: "flex", flexDirection: "column", gap: "2rem" }}>
      <section>
        <h2>status: empty</h2>
        <ReplayPreview status="empty" />
      </section>
      <section>
        <h2>status: loading</h2>
        <ReplayPreview status="loading" label="リプレイを解析しています…" />
      </section>
      <section>
        <h2>status: ready</h2>
        <ReplayPreview status="ready" info={SAMPLE_REPLAY_INFO} />
      </section>
    </div>
  );
}
