import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { GameInfoPage } from "./GameInfoPage.tsx";

describe("GameInfoPage", () => {
  it("対応5タイトルのバージョン情報を表示する", () => {
    render(<GameInfoPage />);

    expect(screen.getByText("東方紅魔郷 ～ the Embodiment of Scarlet Devil.")).toBeTruthy();
    expect(screen.getByText("東方妖々夢 ～ Perfect Cherry Blossom.")).toBeTruthy();
    expect(screen.getByText("東方永夜抄 ～ Imperishable Night.")).toBeTruthy();
    expect(screen.getByText("東方地霊殿 ～ Subterranean Animism.")).toBeTruthy();
    expect(screen.getByText("東方錦上京 ～ Fossilized Wonders.")).toBeTruthy();
    expect(screen.getByText("ver 1.00c")).toBeTruthy();
    expect(screen.getAllByText("vpatch rev4 適用済み")).toHaveLength(2);
    expect(screen.getByText("桜点表示バグ修正適用済み (BugFixCherry = 1)")).toBeTruthy();
  });
});
