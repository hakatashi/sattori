import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReplayInfo } from "@sattori/shared";
import { UploadForm } from "./UploadForm.tsx";
import * as client from "../api/client.ts";

vi.mock("../api/client.ts", () => ({
  SattoriApiError: class extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  createUpload: vi.fn(),
  uploadReplay: vi.fn(),
  parseReplay: vi.fn(),
  requestMagicLink: vi.fn(),
}));

const mocked = vi.mocked(client);

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

function selectFile(name: string, size = 5) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([new Uint8Array(size)], name, { type: "application/octet-stream" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
  return file;
}

function nextStepButton() {
  return screen.getByRole("button", {
    name: /次のステップ|メールを送信しています/,
  }) as HTMLButtonElement;
}

function emailInput() {
  return screen.getByPlaceholderText("you@example.com") as HTMLInputElement;
}

function fillEmail(email: string) {
  fireEvent.change(emailInput(), { target: { value: email } });
}

describe("UploadForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ファイル未選択では次のステップボタンが無効", () => {
    render(<UploadForm onMagicLinkSent={vi.fn()} />);
    expect(nextStepButton().disabled).toBe(true);
  });

  it("ファイル未選択でもSTEP2のプレースホルダーが表示される", () => {
    render(<UploadForm onMagicLinkSent={vi.fn()} />);
    expect(screen.getByText("内容を確認")).toBeTruthy();
    expect(screen.getByText("リプレイファイルを選択すると、ここに内容が表示されます")).toBeTruthy();
  });

  it("ファイル選択欄にファイル名とサイズが表示される", () => {
    render(<UploadForm onMagicLinkSent={vi.fn()} />);
    selectFile("th7_02.rpy", 83866);
    expect(screen.getByText("th7_02.rpy (81.90KB)")).toBeTruthy();
  });

  it("アップロード中・解析中はSTEP2にスピナーとラベルを表示する", async () => {
    let resolveUpload!: (value: { replayKey: string; uploadUrl: string }) => void;
    let resolveParse!: (value: ReplayInfo) => void;
    mocked.createUpload.mockReturnValue(
      new Promise((resolve) => {
        resolveUpload = resolve;
      }),
    );
    mocked.uploadReplay.mockResolvedValue(undefined);
    mocked.parseReplay.mockReturnValue(
      new Promise((resolve) => {
        resolveParse = resolve;
      }),
    );

    render(<UploadForm onMagicLinkSent={vi.fn()} />);
    selectFile("th7_07.rpy");

    await waitFor(() => expect(screen.getByText("アップロード中…")).toBeTruthy());
    expect(screen.getByRole("status", { name: "読み込み中" })).toBeTruthy();

    await act(async () => resolveUpload({ replayKey: "replays/x.rpy", uploadUrl: "https://s3/put" }));

    await waitFor(() => expect(screen.getByText("リプレイを解析しています…")).toBeTruthy());
    expect(screen.getByRole("status", { name: "読み込み中" })).toBeTruthy();

    await act(async () => resolveParse(SAMPLE_REPLAY_INFO));
    fillEmail("user@example.com");

    await waitFor(() => expect(nextStepButton().disabled).toBe(false));
  });

  it(".rpy 以外を選ぶとエラー表示され、アップロードは行われない", () => {
    render(<UploadForm onMagicLinkSent={vi.fn()} />);
    selectFile("bad.txt");
    expect(screen.getByText("リプレイファイル（.rpy）を選択してください")).toBeTruthy();
    expect(mocked.createUpload).not.toHaveBeenCalled();
    expect(nextStepButton().disabled).toBe(true);
  });

  it("ファイル選択で自動アップロード＆解析され、プレビューが表示される（メール未入力では非活性のまま）", async () => {
    mocked.createUpload.mockResolvedValue({ replayKey: "replays/x.rpy", uploadUrl: "https://s3/put" });
    mocked.uploadReplay.mockResolvedValue(undefined);
    mocked.parseReplay.mockResolvedValue(SAMPLE_REPLAY_INFO);

    render(<UploadForm onMagicLinkSent={vi.fn()} />);
    selectFile("th7_07.rpy");

    await waitFor(() => expect(mocked.parseReplay).toHaveBeenCalledWith("replays/x.rpy"));
    expect(mocked.createUpload).toHaveBeenCalledWith({ filename: "th7_07.rpy", size: 5 });
    expect(mocked.uploadReplay).toHaveBeenCalledWith("https://s3/put", expect.any(File));
    // プレビュー内容(ReplayPreview)が表示されている
    await waitFor(() =>
      expect(screen.getByText("東方妖々夢 ～ Perfect Cherry Blossom.")).toBeTruthy(),
    );
    expect(screen.getByText("MarisaA")).toBeTruthy();
    expect(screen.getByText("Extra")).toBeTruthy();
    // メールアドレス未入力のため次のステップはまだ押せない
    expect(nextStepButton().disabled).toBe(true);
  });

  it("メールアドレスも入力すると次のステップボタンが活性化する", async () => {
    mocked.createUpload.mockResolvedValue({ replayKey: "replays/x.rpy", uploadUrl: "https://s3/put" });
    mocked.uploadReplay.mockResolvedValue(undefined);
    mocked.parseReplay.mockResolvedValue(SAMPLE_REPLAY_INFO);

    render(<UploadForm onMagicLinkSent={vi.fn()} />);
    selectFile("th7_07.rpy");
    await waitFor(() => expect(screen.getByText("MarisaA")).toBeTruthy());

    fillEmail("not-an-email");
    expect(nextStepButton().disabled).toBe(true);

    fillEmail("user@example.com");
    expect(nextStepButton().disabled).toBe(false);
  });

  it("解析失敗（非対応タイトル等）ではエラー表示され、次のステップは非活性のまま", async () => {
    mocked.createUpload.mockResolvedValue({ replayKey: "replays/x.rpy", uploadUrl: "https://s3/put" });
    mocked.uploadReplay.mockResolvedValue(undefined);
    mocked.parseReplay.mockRejectedValue(
      new client.SattoriApiError("unsupported_game", "東方地霊殿 ～ Subterranean Animism. は現在録画に対応していません"),
    );

    render(<UploadForm onMagicLinkSent={vi.fn()} />);
    selectFile("th11.rpy");

    await waitFor(() =>
      expect(
        screen.getByText("東方地霊殿 ～ Subterranean Animism. は現在録画に対応していません"),
      ).toBeTruthy(),
    );
    fillEmail("user@example.com");
    expect(nextStepButton().disabled).toBe(true);
    expect(mocked.requestMagicLink).not.toHaveBeenCalled();
  });

  it("次のステップ押下でマジックリンク送信要求が行われ onMagicLinkSent が発火する", async () => {
    mocked.createUpload.mockResolvedValue({ replayKey: "replays/x.rpy", uploadUrl: "https://s3/put" });
    mocked.uploadReplay.mockResolvedValue(undefined);
    mocked.parseReplay.mockResolvedValue(SAMPLE_REPLAY_INFO);
    mocked.requestMagicLink.mockResolvedValue({});
    const onMagicLinkSent = vi.fn();

    render(<UploadForm onMagicLinkSent={onMagicLinkSent} />);
    selectFile("th7_07.rpy");
    await waitFor(() => expect(screen.getByText("MarisaA")).toBeTruthy());
    fillEmail("user@example.com");
    await waitFor(() => expect(nextStepButton().disabled).toBe(false));

    fireEvent.click(nextStepButton());

    await waitFor(() => expect(onMagicLinkSent).toHaveBeenCalledWith("user@example.com"));
    expect(mocked.requestMagicLink).toHaveBeenCalledWith(
      "replays/x.rpy",
      { watermark: true },
      "user@example.com",
      "th07",
      847,
    );
  });
});
