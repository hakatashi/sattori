import { MagicLinkSent } from "../components/MagicLinkSent.tsx";

/**
 * `pnpm dev` で `?preview=magicLinkSent` を付けて開くと、実際のマジックリンク送信を
 * 経由せずに MagicLinkSent の表示を確認できる
 * （デザイン調整用。App.tsx 側で import.meta.env.DEV ガード済みのため本番ビルドには含まれない）。
 */
export function MagicLinkSentPlayground() {
  return (
    <div style={{ maxWidth: "40rem", margin: "0 auto", padding: "2rem" }}>
      <MagicLinkSent email="example@example.com" onBack={() => {}} />
    </div>
  );
}
