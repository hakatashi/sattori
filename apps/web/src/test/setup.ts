import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// 各テスト後に React のレンダリング結果を破棄する。
afterEach(() => {
  cleanup();
});
