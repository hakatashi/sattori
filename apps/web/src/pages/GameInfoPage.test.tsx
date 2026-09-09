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
    expect(screen.getByText("スコア21億でのオーバーフローバグ修正適用済み")).toBeTruthy();
  });

  it("th20・th128にthpracの適用バージョンを表示する(適用理由はタイトルごとに異なる)", () => {
    // ワーカーがゲーム起動直後にアタッチしているthprac（Issue #105）。
    // worker/games/th20/・worker/games/th128/ に同梱している thprac.v2.3.0.3.exe と
    // 一致させること。th20はデシンク軽減が目的だが、th128はリプレイ選択直後の
    // フリーズ回避が目的で理由が異なる(worker/docs/titles/th128.md)ため、
    // 表示文言もタイトルごとに分ける。
    render(<GameInfoPage />);

    expect(screen.getAllByText("thprac v2.3.0.3 適用済み")).toHaveLength(2);
    expect(screen.getByText("リプレイずれの軽減のため、録画時に適用しています")).toBeTruthy();
    expect(
      screen.getByText("リプレイ選択直後にゲーム本体が停止する不具合を回避するため、録画時に適用しています"),
    ).toBeTruthy();
  });
});
