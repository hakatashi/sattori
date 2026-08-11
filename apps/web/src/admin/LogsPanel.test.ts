import { describe, expect, it } from "vitest";
import type { AdminLogEvent } from "@sattori/shared";
import { mergeTailEvents } from "./LogsPanel.tsx";

/**
 * 自動更新のマージ（`tail -f`相当の追尾）。パネル全体の描画・追尾の挙動は
 * `JobDetailPage.test.tsx`「ワーカーログの追尾」で見ているので、ここは
 * 履歴の継ぎ足しと打ち切りの境界だけを直接確かめる。
 */
describe("mergeTailEvents", () => {
  const event = (timestamp: number, message: string): AdminLogEvent => ({ timestamp, message });

  it("重なりを見つけて、そこから後ろを新しいページで置き換える", () => {
    const prev = [event(1, "a"), event(2, "b"), event(3, "c")];
    const incoming = [event(2, "b"), event(3, "c"), event(4, "d")];

    const result = mergeTailEvents(prev, incoming);

    // 「さらに古いログを読み込む」で積んだ先頭(a)は捨てない。
    expect(result.events).toEqual([event(1, "a"), event(2, "b"), event(3, "c"), event(4, "d")]);
    expect(result.replaced).toBe(false);
  });

  it("重なりが無ければ履歴を捨てて新しいページだけにする(カーソルの取り直しが必要)", () => {
    const prev = [event(1, "a"), event(2, "b")];
    const incoming = [event(90, "x"), event(91, "y")];

    const result = mergeTailEvents(prev, incoming);

    expect(result.events).toEqual(incoming);
    expect(result.replaced).toBe(true);
  });

  it("表示中のログが無ければ新しいページをそのまま採用する", () => {
    const incoming = [event(1, "a")];

    const result = mergeTailEvents([], incoming);

    expect(result.events).toEqual(incoming);
    expect(result.replaced).toBe(true);
  });

  it("新しいページが空でも表示中のログを消さない", () => {
    const prev = [event(1, "a")];

    const result = mergeTailEvents(prev, []);

    expect(result.events).toEqual(prev);
    expect(result.replaced).toBe(false);
  });
});
