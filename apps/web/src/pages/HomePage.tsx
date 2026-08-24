import { UploadForm } from "../components/UploadForm.tsx";

/**
 * ページA（`/`）。リプレイのアップロード〜マジックリンク送信要求まで。送信後の
 * 「メールを確認してください」画面（`MagicLinkSent`）はファイル選択・`replayKey`を
 * 保持したまま「戻る」で入力フォームへ戻れる必要があるため、`UploadForm`が
 * 自身のstateとして内包する。
 */
export function HomePage() {
  return <UploadForm />;
}
