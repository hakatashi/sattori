import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { GameInfoPage } from "./GameInfoPage.tsx";

describe("GameInfoPage", () => {
  it("対応4タイトルのバージョン情報を表示する", () => {
    render(<GameInfoPage />);

    expect(screen.getByText("東方紅魔郷 ～ the Embodiment of Scarlet Devil.")).toBeTruthy();
    expect(screen.getByText("東方妖々夢 ～ Perfect Cherry Blossom.")).toBeTruthy();
    expect(screen.getByText("東方永夜抄 ～ Imperishable Night.")).toBeTruthy();
    expect(screen.getByText("東方地霊殿 ～ Subterranean Animism.")).toBeTruthy();
    expect(screen.getByText("vpatch rev4 適用済み")).toBeTruthy();
  });
});
