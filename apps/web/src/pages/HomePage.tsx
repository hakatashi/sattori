import { useState } from "react";
import { UploadForm } from "../components/UploadForm.tsx";
import { MagicLinkSent } from "../components/MagicLinkSent.tsx";

type View = { kind: "upload" } | { kind: "sent"; email: string };

/** ページA（`/`）。リプレイのアップロード〜マジックリンク送信要求まで。 */
export function HomePage() {
  const [view, setView] = useState<View>({ kind: "upload" });

  if (view.kind === "sent") {
    return (
      <MagicLinkSent email={view.email} onReset={() => setView({ kind: "upload" })} />
    );
  }

  return <UploadForm onMagicLinkSent={(email) => setView({ kind: "sent", email })} />;
}
