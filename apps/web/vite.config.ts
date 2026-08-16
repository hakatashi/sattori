/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { ViteMinifyPlugin } from "vite-plugin-minify";

const fromHere = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** パスの末尾セグメントに拡張子があるか（= 実ファイル要求か）。 */
function looksLikeFile(pathname: string): boolean {
  return pathname.slice(pathname.lastIndexOf("/") + 1).includes(".");
}

/**
 * 開発サーバのSPAフォールバックを本番(CloudFront Function)と揃えるプラグイン。
 * Vite標準のフォールバック先はルートの`index.html`のみで、`/en/jobs/xxx`のような
 * 深いパスでも日本語版HTMLが返ってしまい、OGP/metaの言語出し分けをローカルで
 * 確認できないため、`/en`配下は`en/index.html`へ書き換える。
 * 本番側の同等のルーティングは`infra/lib/sattori-stack.ts`のWebRouting関数。
 */
function enLocaleSpaFallback(): Plugin {
  return {
    name: "sattori:en-locale-spa-fallback",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const pathname = (req.url ?? "").split("?")[0] ?? "";
        if ((pathname === "/en" || pathname.startsWith("/en/")) && !looksLikeFile(pathname)) {
          req.url = "/en/index.html";
        }
        next();
      });
    },
  };
}

export default defineConfig({
  // 素のViteはHTMLを素通しする（JS/CSSしかminifyしない）ため、`index.html`/
  // `en/index.html`のソースコメント（内部設計事情。jobIdが秘密値であること等）が
  // そのまま配信物に乗ってしまう。ビルド時のみ動作するViteMinifyPlugin(html-minifier-next
  // ラッパー)でコメント除去・空白圧縮を行う。
  plugins: [react(), enLocaleSpaFallback(), ViteMinifyPlugin()],
  build: {
    // 言語ごとに実体のHTMLを配る（クローラーはJSを実行しないため、OGP・titleの
    // 言語出し分けはビルド時に別ファイルとして吐くしかない）。
    // 出力は `dist/index.html`(ja) と `dist/en/index.html`(en)。
    rollupOptions: {
      input: {
        main: fromHere("index.html"),
        en: fromHere("en/index.html"),
      },
    },
  },
  server: {
    port: 5173,
    // 開発時は API をバックエンドにプロキシ（VITE_API_BASE で上書き可能）。
    // `/beacon`（Issue #142）は`API_BASE`を経由しない相対パス固定のため別エントリが要る
    // （本番ではCloudFrontの`/beacon`ビヘイビア経由、`infra/lib/sattori-stack.ts`参照。
    // 開発サーバではCloudFrontを挟まないため`CloudFront-Viewer-Country`は付かない）。
    proxy: process.env.VITE_API_BASE
      ? undefined
      : { "/api": "http://localhost:8787", "/beacon": "http://localhost:8787" },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
