import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "../i18n/i18n.ts";

// 各テスト後に React のレンダリング結果を破棄する。
afterEach(() => {
  cleanup();
});
