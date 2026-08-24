import { useState } from "react";
import { MagicLinkSent } from "../components/MagicLinkSent.tsx";

/**
 * `pnpm dev` で `?preview=magicLinkSent` を付けて開くと、実際のマジックリンク送信を
 * 経由せずに MagicLinkSent の各状態をまとめて確認できる
 * （デザイン調整用。App.tsx 側で import.meta.env.DEV ガード済みのため本番ビルドには含まれない）。
 */
export function MagicLinkSentPlayground() {
  const [resending, setResending] = useState(false);

  return (
    <div style={{ maxWidth: "40rem", margin: "0 auto", padding: "2rem", display: "flex", flexDirection: "column", gap: "2rem" }}>
      <section>
        <h2>通常表示</h2>
        <MagicLinkSent
          email="example@example.com"
          onResend={() => {}}
          onBack={() => {}}
          resending={false}
          resendError={null}
        />
      </section>
      <section>
        <h2>再送中（ボタン無効化）</h2>
        <MagicLinkSent
          email="example@example.com"
          onResend={() => {}}
          onBack={() => {}}
          resending={true}
          resendError={null}
        />
      </section>
      <section>
        <h2>再送失敗（エラーメッセージあり）</h2>
        <MagicLinkSent
          email="example@example.com"
          onResend={() => {}}
          onBack={() => {}}
          resending={false}
          resendError="再送に失敗しました。しばらくしてから再試行してください。"
        />
      </section>
      <section>
        <h2>操作可能（onResend押下でresending状態をトグル）</h2>
        <MagicLinkSent
          email="example@example.com"
          onResend={() => setResending((prev) => !prev)}
          onBack={() => {}}
          resending={resending}
          resendError={null}
        />
      </section>
    </div>
  );
}
