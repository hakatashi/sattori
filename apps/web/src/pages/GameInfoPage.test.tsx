import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { GameInfoPage } from "./GameInfoPage.tsx";

describe("GameInfoPage", () => {
  it("対応7タイトルのバージョン情報を表示する", () => {
    render(<GameInfoPage />);

    expect(screen.getByText("東方紅魔郷 ～ the Embodiment of Scarlet Devil.")).toBeTruthy();
    expect(screen.getByText("東方妖々夢 ～ Perfect Cherry Blossom.")).toBeTruthy();
    expect(screen.getByText("東方永夜抄 ～ Imperishable Night.")).toBeTruthy();
    expect(screen.getByText("東方風神録 ～ Mountain of Faith.")).toBeTruthy();
    expect(screen.getByText("東方地霊殿 ～ Subterranean Animism.")).toBeTruthy();
    expect(screen.getByText("東方星蓮船 ～ Undefined Fantastic Object.")).toBeTruthy();
    expect(screen.getByText("東方錦上京 ～ Fossilized Wonders.")).toBeTruthy();
    expect(screen.getByText("ver 1.00c")).toBeTruthy();
    expect(screen.getAllByText("vpatch rev4 適用済み")).toHaveLength(3);
    expect(screen.getByText("vpatch rev7 適用済み")).toBeTruthy();
    expect(screen.getByText("桜点表示バグ修正適用済み (BugFixCherry = 1)")).toBeTruthy();
    expect(
      screen.getByText("魔理沙Bのショット威力バグ修正オプションが利用可能 (BugFixTh10Power3)"),
    ).toBeTruthy();
  });

  it("th20にthpracの適用バージョンを表示する", () => {
    // ワーカーがゲーム起動直後にアタッチしているthprac（Issue #105）。
    // worker/games/th20/ に同梱している thprac.v2.3.0.3.exe と一致させること。
    render(<GameInfoPage />);

    expect(screen.getByText("thprac v2.3.0.3 適用済み")).toBeTruthy();
    expect(screen.getByText("リプレイずれの軽減のため、録画時に適用しています")).toBeTruthy();
  });
});
