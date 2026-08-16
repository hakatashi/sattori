import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ReplayHelpPage } from "./ReplayHelpPage.tsx";

describe("ReplayHelpPage", () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
  });

  it("既定では東方紅魔郷とth20の場所を表示する", () => {
    render(<ReplayHelpPage />);

    expect(screen.getByRole("heading", { name: "リプレイファイルの場所" })).toBeTruthy();
    expect(screen.getByText(/「東方紅魔郷」をインストールしたフォルダ/)).toBeTruthy();
    expect(screen.getByText("C:\\Program Files (x86)\\Steam\\steamapps\\common\\th06\\replay")).toBeTruthy();
    expect(screen.getByText("%APPDATA%\\ShanghaiAlice\\th20\\replay")).toBeTruthy();
  });

  it("作品ボタンを切り替えるとパスの表示が変わる", () => {
    render(<ReplayHelpPage />);

    fireEvent.click(screen.getByRole("button", { name: /東方地霊殿/ }));

    expect(screen.getByText(/「東方地霊殿」をインストールしたフォルダ/)).toBeTruthy();
    expect(screen.getByText("C:\\Program Files (x86)\\Steam\\steamapps\\common\\th11\\replay")).toBeTruthy();
  });

  it("コピーボタンでパスをクリップボードにコピーする", async () => {
    render(<ReplayHelpPage />);

    const copyButton = screen.getAllByRole("button", { name: "コピー" }).at(0);
    fireEvent.click(copyButton!);

    expect(writeText).toHaveBeenCalledWith("C:\\Program Files (x86)\\Steam\\steamapps\\common\\th06\\replay");
    expect(await screen.findByText("コピーしました")).toBeTruthy();
  });
});
