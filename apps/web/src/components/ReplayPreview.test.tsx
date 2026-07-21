import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReplayInfo } from "@sattori/shared";
import { formatDuration, ReplayPreview } from "./ReplayPreview.tsx";

const SAMPLE_REPLAY_INFO: ReplayInfo = {
  game: "th07",
  player: "koyi",
  date: "01/18",
  character: "MarisaA",
  difficulty: "Extra",
  stage: null,
  score: 303766040,
  cleared: true,
  estimatedDurationSeconds: 847,
};

describe("ReplayPreview", () => {
  it("status=ready で解析結果の主要項目を表示する", () => {
    render(<ReplayPreview status="ready" info={SAMPLE_REPLAY_INFO} />);
    expect(screen.getByText("東方妖々夢 ～ Perfect Cherry Blossom.")).toBeTruthy();
    expect(screen.getByText("MarisaA")).toBeTruthy();
    expect(screen.getByText("Extra")).toBeTruthy();
    expect(screen.getByText("303,766,040")).toBeTruthy();
    expect(screen.getByText("01/18")).toBeTruthy();
    expect(screen.getByText("クリア", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText("14分07秒")).toBeTruthy();
  });

  it("status=empty ではファイル未選択のプレースホルダーを表示する", () => {
    render(<ReplayPreview status="empty" />);
    expect(screen.getByText("リプレイファイルを選択すると、ここに内容が表示されます")).toBeTruthy();
  });

  it("status=loading ではスピナーとラベルを表示する", () => {
    render(<ReplayPreview status="loading" label="リプレイを解析しています…" />);
    expect(screen.getByRole("status", { name: "読み込み中" })).toBeTruthy();
    expect(screen.getByText("リプレイを解析しています…")).toBeTruthy();
  });
});

describe("formatDuration", () => {
  it("秒数を「◯分◯◯秒」に変換する", () => {
    expect(formatDuration(847)).toBe("14分07秒");
    expect(formatDuration(60)).toBe("1分00秒");
    expect(formatDuration(5)).toBe("0分05秒");
  });

  it("null は「不明」を返す", () => {
    expect(formatDuration(null)).toBe("不明");
  });
});
