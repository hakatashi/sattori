import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { GAME_IDS } from "@sattori/shared";
import { ReplayHelpPage } from "./ReplayHelpPage.tsx";

describe("ReplayHelpPage", () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
  });

  it("既定では東方紅魔郷の場所を表示する（th06はSteam版が無いのでSteamのパスは出さない）", () => {
    render(<ReplayHelpPage />);

    expect(screen.getByRole("heading", { name: "東方Project作品のリプレイファイルの保存場所" })).toBeTruthy();
    expect(screen.getAllByRole("group")).toHaveLength(1);
    expect(screen.getByText(/「東方紅魔郷」をインストールしたフォルダ/)).toBeTruthy();
    expect(screen.getByText("C:\\Program Files (x86)\\東方紅魔郷\\replay")).toBeTruthy();
    expect(screen.getByText("%LOCALAPPDATA%\\VirtualStore\\Program Files (x86)\\東方紅魔郷\\replay")).toBeTruthy();
    expect(screen.queryByText("C:\\Program Files (x86)\\Steam\\steamapps\\common\\th06\\replay")).toBeNull();
    expect(screen.queryByText("%APPDATA%\\ShanghaiAlice\\th20\\replay")).toBeNull();
  });

  it("すべての作品の選択ボタンが1つのボタングループに含まれる", () => {
    render(<ReplayHelpPage />);

    const group = screen.getByRole("group");
    for (const gameId of GAME_IDS) {
      expect(group.querySelector(`button img[src="/icons/${gameId}.png"]`)).toBeTruthy();
    }
  });

  it("th06c(紅魔郷リメイク)を選択するとSteamライブラリ配下のゲームディレクトリを案内する", () => {
    render(<ReplayHelpPage />);

    fireEvent.click(screen.getByRole("button", { name: /東方紅魔郷: Classic/ }));

    expect(screen.getByText(/「東方紅魔郷: Classic」のリプレイファイルの取り出しは、現在Steam版でのみ確認されています/)).toBeTruthy();
    expect(screen.getByText("C:\\Program Files (x86)\\Steam\\steamapps\\common\\th06c\\replay")).toBeTruthy();
  });

  it("録画非対応タイトル(東方風神録)も選択するとSteamのパスも出す", () => {
    render(<ReplayHelpPage />);

    expect(screen.getByRole("button", { name: /東方風神録/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /東方風神録/ }));

    expect(screen.getByText(/「東方風神録」をインストールしたフォルダ/)).toBeTruthy();
    expect(screen.getByText("C:\\Program Files (x86)\\上海アリス幻樂団\\東方風神録\\replay")).toBeTruthy();
    expect(screen.getByText("C:\\Program Files (x86)\\Steam\\steamapps\\common\\th10\\replay")).toBeTruthy();
  });

  it("録画非対応タイトル(ダブルスポイラー以降)を選択すると%APPDATA%のパスを表示する", () => {
    render(<ReplayHelpPage />);

    fireEvent.click(screen.getByRole("button", { name: /ダブルスポイラー/ }));

    expect(screen.getByText(/「ダブルスポイラー」では、ユーザーの %APPDATA% フォルダに/)).toBeTruthy();
    expect(screen.getByText("%APPDATA%\\ShanghaiAlice\\th125\\replay")).toBeTruthy();
  });

  it("作品ボタンを切り替えるとパスの表示が変わる", () => {
    render(<ReplayHelpPage />);

    fireEvent.click(screen.getByRole("button", { name: /東方地霊殿/ }));

    expect(screen.getByText(/「東方地霊殿」をインストールしたフォルダ/)).toBeTruthy();
    expect(screen.getByText("C:\\Program Files (x86)\\上海アリス幻樂団\\東方地霊殿\\replay")).toBeTruthy();
    expect(screen.getByText("C:\\Program Files (x86)\\Steam\\steamapps\\common\\th11\\replay")).toBeTruthy();
  });

  it("コピーボタンでパスをクリップボードにコピーする", async () => {
    render(<ReplayHelpPage />);

    const copyButton = screen.getAllByRole("button", { name: "コピー" }).at(0);
    fireEvent.click(copyButton!);

    expect(writeText).toHaveBeenCalledWith("C:\\Program Files (x86)\\東方紅魔郷\\replay");
    expect(await screen.findByText("コピーしました")).toBeTruthy();
  });
});
