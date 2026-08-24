import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChangelogPage, groupByDate } from "./ChangelogPage.tsx";
import { changelogEntries } from "../data/changelog.ts";
import { LocaleContext } from "../i18n/LocaleContext.ts";

describe("ChangelogPage", () => {
  it("見出しと全エントリの説明文を表示する", () => {
    render(<ChangelogPage />);

    expect(screen.getByRole("heading", { name: "更新履歴" })).toBeTruthy();
    for (const entry of changelogEntries) {
      expect(screen.getByText(entry.ja)).toBeTruthy();
    }
  });

  it("英語ロケールでは英語の説明文を表示する", () => {
    render(
      <LocaleContext.Provider value="en">
        <ChangelogPage />
      </LocaleContext.Provider>,
    );

    for (const entry of changelogEntries) {
      expect(screen.getByText(entry.en)).toBeTruthy();
    }
  });
});

describe("groupByDate", () => {
  it("同じ日付が連続するエントリを1つのグループへまとめる", () => {
    const groups = groupByDate([
      { date: "2026-08-24", ja: "A", en: "A" },
      { date: "2026-08-24", ja: "B", en: "B" },
      { date: "2026-08-23", ja: "C", en: "C" },
    ]);

    expect(groups).toEqual([
      {
        date: "2026-08-24",
        entries: [
          { date: "2026-08-24", ja: "A", en: "A" },
          { date: "2026-08-24", ja: "B", en: "B" },
        ],
      },
      { date: "2026-08-23", entries: [{ date: "2026-08-23", ja: "C", en: "C" }] },
    ]);
  });
});
