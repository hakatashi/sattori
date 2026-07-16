/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
