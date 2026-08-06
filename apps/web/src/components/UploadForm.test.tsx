import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReplayInfo } from "@sattori/shared";
import { UploadForm } from "./UploadForm.tsx";
import * as client from "../api/client.ts";
import * as shared from "@sattori/shared";

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
  requestMagicLink: vi.fn(),
}));

vi.mock("@sattori/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sattori/shared")>();
  return {
    ...actual,
    parseReplayInfo: vi.fn(),
  };
});

const mockedClient = vi.mocked(client);
const mockedShared = vi.mocked(shared);

const SAMPLE_REPLAY_INFO: ReplayInfo = {
  game: "th07",
  player: "koyi",
  date: "01/18",
  character: "MarisaA",
  characterNameJa: null,
  characterNameEn: null,
  difficulty: "Extra",
  stage: null,
  score: 303766040,
  cleared: true,
  estimatedDurationSeconds: 847,
};

function renderUploadForm(onMagicLinkSent: (email: string) => void) {
  return render(
    <MemoryRouter>
      <UploadForm onMagicLinkSent={onMagicLinkSent} />
    </MemoryRouter>,
  );
}

function selectFile(name: string, size = 5) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([new Uint8Array(size)], name, { type: "application/octet-stream" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
  return file;
}

function nextStepButton() {
  return screen.getByRole("button", {
    name: /次へ|少女祈祷中/,
  }) as HTMLButtonElement;
}

function emailInput() {
  return screen.getByPlaceholderText("komeiji@example.com") as HTMLInputElement;
}

function fillEmail(email: string) {
  fireEvent.change(emailInput(), { target: { value: email } });
}

describe("UploadForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ファイル未選択では次のステップボタンが無効", () => {
    renderUploadForm(vi.fn());
    expect(nextStepButton().disabled).toBe(true);
  });

  it("ファイル未選択でもSTEP2のプレースホルダーが表示される", () => {
    renderUploadForm(vi.fn());
    expect(screen.getByText("内容を確認")).toBeTruthy();
    expect(screen.getByText("リプレイファイルを選択すると、ここに内容が表示されます")).toBeTruthy();
  });

  it("ファイル選択欄にファイル名とサイズが表示される", () => {
    renderUploadForm(vi.fn());
    selectFile("th7_02.rpy", 83866);
    expect(screen.getByText("th7_02.rpy (81.90KB)")).toBeTruthy();
  });

  it("ファイル選択直後はSTEP2に解析中のスピナーを表示する（ブラウザ内解析はアップロード完了を待たない）", () => {
    mockedClient.createUpload.mockReturnValue(new Promise(() => {}));
    mockedClient.uploadReplay.mockResolvedValue(undefined);
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: SAMPLE_REPLAY_INFO });

    renderUploadForm(vi.fn());
    selectFile("th7_07.rpy");

    // setPhase("processing") はブラウザ内解析・アップロードの最初のawaitより前に同期的に走るため、
    // fireEvent.change直後の時点で既に解析中スピナーが見える。
    expect(screen.getByText("リプレイを解析しています…")).toBeTruthy();
    expect(screen.getByRole("status", { name: "読み込み中" })).toBeTruthy();
  });

  it("解析はアップロード完了を待たずに終わり、アップロード中は次のステップへ進めない", async () => {
    let resolveUpload!: (value: { replayKey: string; uploadUrl: string }) => void;
    mockedClient.createUpload.mockReturnValue(
      new Promise((resolve) => {
        resolveUpload = resolve;
      }),
    );
    mockedClient.uploadReplay.mockResolvedValue(undefined);
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: SAMPLE_REPLAY_INFO });

    renderUploadForm(vi.fn());
    selectFile("th7_07.rpy");

    // ブラウザ内解析（アップロードとは独立）が先に終わり、プレビューが表示される
    await waitFor(() => expect(screen.getByText("MarisaA")).toBeTruthy());
    expect(screen.getByText("アップロード中…")).toBeTruthy();
    fillEmail("user@example.com");
    expect(nextStepButton().disabled).toBe(true);

    await act(async () => resolveUpload({ replayKey: "replays/x.rpy", uploadUrl: "https://s3/put" }));

    await waitFor(() => expect(nextStepButton().disabled).toBe(false));
    expect(screen.queryByText("アップロード中…")).toBeNull();
  });

  it(".rpy 以外を選ぶとエラー表示され、アップロードは行われない", () => {
    renderUploadForm(vi.fn());
    selectFile("bad.txt");
    expect(screen.getByText("リプレイファイル (.rpy) を選択してください")).toBeTruthy();
    expect(mockedClient.createUpload).not.toHaveBeenCalled();
    expect(nextStepButton().disabled).toBe(true);
  });

  it("ファイル選択で自動アップロード＆解析され、プレビューが表示される（メール未入力では非活性のまま）", async () => {
    mockedClient.createUpload.mockResolvedValue({ replayKey: "replays/x.rpy", uploadUrl: "https://s3/put" });
    mockedClient.uploadReplay.mockResolvedValue(undefined);
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: SAMPLE_REPLAY_INFO });

    renderUploadForm(vi.fn());
    selectFile("th7_07.rpy");

    await waitFor(() => expect(mockedShared.parseReplayInfo).toHaveBeenCalledWith(expect.any(Uint8Array)));
    expect(mockedClient.createUpload).toHaveBeenCalledWith({ filename: "th7_07.rpy", size: 5 });
    expect(mockedClient.uploadReplay).toHaveBeenCalledWith("https://s3/put", expect.any(File));
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
    mockedClient.createUpload.mockResolvedValue({ replayKey: "replays/x.rpy", uploadUrl: "https://s3/put" });
    mockedClient.uploadReplay.mockResolvedValue(undefined);
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: SAMPLE_REPLAY_INFO });

    renderUploadForm(vi.fn());
    selectFile("th7_07.rpy");
    await waitFor(() => expect(screen.getByText("MarisaA")).toBeTruthy());
    await waitFor(() => expect(mockedClient.uploadReplay).toHaveBeenCalled());

    fillEmail("not-an-email");
    expect(nextStepButton().disabled).toBe(true);

    fillEmail("user@example.com");
    await waitFor(() => expect(nextStepButton().disabled).toBe(false));
  });

  it("解析失敗（非対応タイトル等）ではエラー表示され、次のステップは非活性のまま", async () => {
    mockedClient.createUpload.mockResolvedValue({ replayKey: "replays/x.rpy", uploadUrl: "https://s3/put" });
    mockedClient.uploadReplay.mockResolvedValue(undefined);
    mockedShared.parseReplayInfo.mockReturnValue({
      ok: false,
      error: {
        code: "unsupported_game",
        message: "東方星蓮船 ～ Undefined Fantastic Object. は現在録画に対応していません",
      },
    });

    renderUploadForm(vi.fn());
    selectFile("th12.rpy");

    await waitFor(() =>
      expect(
        screen.getByText("東方星蓮船 ～ Undefined Fantastic Object. は現在録画に対応していません"),
      ).toBeTruthy(),
    );
    fillEmail("user@example.com");
    expect(nextStepButton().disabled).toBe(true);
    expect(mockedClient.requestMagicLink).not.toHaveBeenCalled();
  });

  it("次のステップ押下でマジックリンク送信要求が行われ onMagicLinkSent が発火する", async () => {
    mockedClient.createUpload.mockResolvedValue({ replayKey: "replays/x.rpy", uploadUrl: "https://s3/put" });
    mockedClient.uploadReplay.mockResolvedValue(undefined);
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: SAMPLE_REPLAY_INFO });
    mockedClient.requestMagicLink.mockResolvedValue({});
    const onMagicLinkSent = vi.fn();

    renderUploadForm(onMagicLinkSent);
    selectFile("th7_07.rpy");
    await waitFor(() => expect(screen.getByText("MarisaA")).toBeTruthy());
    await waitFor(() => expect(mockedClient.uploadReplay).toHaveBeenCalled());
    fillEmail("user@example.com");
    await waitFor(() => expect(nextStepButton().disabled).toBe(false));

    fireEvent.click(nextStepButton());

    await waitFor(() => expect(onMagicLinkSent).toHaveBeenCalledWith("user@example.com"));
    expect(mockedClient.requestMagicLink).toHaveBeenCalledWith(
      "replays/x.rpy",
      { watermark: true },
      "user@example.com",
      "ja",
      SAMPLE_REPLAY_INFO,
    );
  });
});
