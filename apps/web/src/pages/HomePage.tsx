import { UploadForm } from "../components/UploadForm.tsx";
import { usePageMeta } from "../hooks/usePageMeta.ts";

/**
 * ページA（`/`）。リプレイのアップロード〜マジックリンク送信要求まで。送信後の
 * 「メールを確認してください」画面（`MagicLinkSent`）はファイル選択・`replayKey`を
 * 保持したまま「戻る」で入力フォームへ戻れる必要があるため、`UploadForm`が
 * 自身のstateとして内包する。
 */
export function HomePage() {
  // titleを省略するとエントリHTML（index.html/en/index.html）と同じ既定タイトルになる。
  usePageMeta({ path: "/" });
  return <UploadForm />;
}
