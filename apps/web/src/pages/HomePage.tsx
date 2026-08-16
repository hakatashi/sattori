import { UploadForm } from "../components/UploadForm.tsx";

/**
 * ページA（`/`）。リプレイのアップロード〜マジックリンク送信要求まで。送信後の
 * 「メールを確認してください」画面（`MagicLinkSent`）はファイル選択・`replayKey`を
 * 保持したまま戻れる必要がある（Issue #139 UX-5の再送導線）ため、`UploadForm`が
 * 自身のstateとして内包する。
 */
export function HomePage() {
  return <UploadForm />;
}
