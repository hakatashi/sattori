import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["cdk.out/**", "node_modules/**"],
    // NodejsFunction の esbuild バンドルを伴う synth のため長めに取る。
    testTimeout: 60_000,
  },
});
