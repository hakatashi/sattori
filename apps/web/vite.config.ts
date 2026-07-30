/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

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
  plugins: [react(), enLocaleSpaFallback()],
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
    proxy: process.env.VITE_API_BASE
      ? undefined
      : { "/api": "http://localhost:8787" },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
