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
  it("解析結果の主要項目を表示する", () => {
    render(<ReplayPreview info={SAMPLE_REPLAY_INFO} />);
    expect(screen.getByText("東方妖々夢 ～ Perfect Cherry Blossom.")).toBeTruthy();
    expect(screen.getByText("MarisaA")).toBeTruthy();
    expect(screen.getByText("Extra")).toBeTruthy();
    expect(screen.getByText("303,766,040")).toBeTruthy();
    expect(screen.getByText("01/18")).toBeTruthy();
    expect(screen.getByText("クリア", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText("14分07秒")).toBeTruthy();
  });

  it("null の項目は「不明」と表示する", () => {
    render(
      <ReplayPreview
        info={{ ...SAMPLE_REPLAY_INFO, stage: null, cleared: null, estimatedDurationSeconds: null }}
      />,
    );
    const unknowns = screen.getAllByText("不明");
    expect(unknowns.length).toBeGreaterThanOrEqual(3);
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
