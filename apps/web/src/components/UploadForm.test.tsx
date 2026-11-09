import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReplayInfo } from "@sattori/shared";
import { UploadForm } from "./UploadForm.tsx";
import { UploadFormStateContext, useUploadFormPersistedState } from "./UploadFormStateContext.ts";
import * as analytics from "../api/analytics.ts";
import * as client from "../api/client.ts";
import * as shared from "@sattori/shared";

vi.mock("../api/analytics.ts", () => ({
  trackPageview: vi.fn(),
  trackParseError: vi.fn(),
}));

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
const mockedAnalytics = vi.mocked(analytics);

const SAMPLE_REPLAY_INFO: ReplayInfo = {
  game: "th08",
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

/** 本番では`App.tsx`の`Layout`が持つ`UploadFormStateContext`を、テストではここで肩代わりする。 */
function UploadFormWithState() {
  const state = useUploadFormPersistedState();
  return (
    <UploadFormStateContext.Provider value={state}>
      <UploadForm />
    </UploadFormStateContext.Provider>
  );
}

function renderUploadForm() {
  return render(
    <MemoryRouter>
      <UploadFormWithState />
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

const TH20_REPLAY_INFO: ReplayInfo = {
  ...SAMPLE_REPLAY_INFO,
  game: "th20",
  difficulty: "Hard",
  estimatedDurationSeconds: 1757,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedClient.createUpload.mockResolvedValue({
    replayKey: "replays/x.rpy",
    uploadUrl: "https://s3.example.com/put",
  });
  mockedClient.uploadReplay.mockResolvedValue(undefined);
});

describe("UploadForm", () => {

  it("ファイル未選択では次のステップボタンが無効", () => {
    renderUploadForm();
    expect(nextStepButton().disabled).toBe(true);
  });

  it("ファイル未選択でもSTEP2のプレースホルダーが表示される", () => {
    renderUploadForm();
    expect(screen.getByText("内容を確認")).toBeTruthy();
    expect(screen.getByText("まずはリプレイファイルを選択してください")).toBeTruthy();
  });

  it("ファイル選択欄にファイル名とサイズが表示される", () => {
    renderUploadForm();
    selectFile("th7_02.rpy", 83866);
    expect(screen.getByText("th7_02.rpy (81.90KB)")).toBeTruthy();
  });

  it("ファイル選択直後はSTEP2に解析中のスピナーを表示する（ブラウザ内解析はアップロード完了を待たない）", () => {
    mockedClient.createUpload.mockReturnValue(new Promise(() => {}));
    mockedClient.uploadReplay.mockResolvedValue(undefined);
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: SAMPLE_REPLAY_INFO });

    renderUploadForm();
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

    renderUploadForm();
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
    renderUploadForm();
    selectFile("bad.txt");
    expect(screen.getByText("リプレイファイル (.rpy) を選択してください")).toBeTruthy();
    expect(mockedClient.createUpload).not.toHaveBeenCalled();
    expect(nextStepButton().disabled).toBe(true);
  });

  it("ファイル選択で自動アップロード＆解析され、プレビューが表示される（メール未入力では非活性のまま）", async () => {
    mockedClient.createUpload.mockResolvedValue({ replayKey: "replays/x.rpy", uploadUrl: "https://s3/put" });
    mockedClient.uploadReplay.mockResolvedValue(undefined);
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: SAMPLE_REPLAY_INFO });

    renderUploadForm();
    selectFile("th7_07.rpy");

    await waitFor(() => expect(mockedShared.parseReplayInfo).toHaveBeenCalledWith(expect.any(Uint8Array)));
    expect(mockedClient.createUpload).toHaveBeenCalledWith({ filename: "th7_07.rpy", size: 5 });
    expect(mockedClient.uploadReplay).toHaveBeenCalledWith("https://s3/put", expect.any(File));
    // プレビュー内容(ReplayPreview)が表示されている
    await waitFor(() =>
      expect(screen.getByText("東方永夜抄 ～ Imperishable Night.")).toBeTruthy(),
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

    renderUploadForm();
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
        message: "東方花映塚 ～ Phantasmagoria of Flower View. は現在録画に対応していません",
        game: "th09",
      },
    });

    renderUploadForm();
    selectFile("th09.rpy");

    await waitFor(() =>
      expect(
        screen.getByText("東方花映塚 ～ Phantasmagoria of Flower View. は現在録画に対応していません"),
      ).toBeTruthy(),
    );
    fillEmail("user@example.com");
    expect(nextStepButton().disabled).toBe(true);
    expect(mockedClient.requestMagicLink).not.toHaveBeenCalled();
    // パースエラーの発生率計測(Issue #142)。検出タイトルも一緒に送る。
    expect(mockedAnalytics.trackParseError).toHaveBeenCalledWith("unsupported_game", "th09");
  });

  it("次のステップ押下でマジックリンク送信要求が行われ、送信完了画面に遷移する", async () => {
    mockedClient.createUpload.mockResolvedValue({ replayKey: "replays/x.rpy", uploadUrl: "https://s3/put" });
    mockedClient.uploadReplay.mockResolvedValue(undefined);
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: SAMPLE_REPLAY_INFO });
    mockedClient.requestMagicLink.mockResolvedValue({});

    renderUploadForm();
    selectFile("th7_07.rpy");
    await waitFor(() => expect(screen.getByText("MarisaA")).toBeTruthy());
    await waitFor(() => expect(mockedClient.uploadReplay).toHaveBeenCalled());
    fillEmail("user@example.com");
    await waitFor(() => expect(nextStepButton().disabled).toBe(false));

    fireEvent.click(nextStepButton());

    await waitFor(() => expect(screen.getByText("メールを確認してください")).toBeTruthy());
    expect(mockedClient.requestMagicLink).toHaveBeenCalledWith(
      "replays/x.rpy",
      { watermark: true, th10BugfixMarisaB: false, th06ncHighResolution: false },
      "user@example.com",
      "ja",
    );
  });

  it("送信完了画面の「アップロード画面に戻る」でファイル・replayKeyを保持したまま入力フォームへ戻る", async () => {
    mockedClient.createUpload.mockResolvedValue({ replayKey: "replays/x.rpy", uploadUrl: "https://s3/put" });
    mockedClient.uploadReplay.mockResolvedValue(undefined);
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: SAMPLE_REPLAY_INFO });
    mockedClient.requestMagicLink.mockResolvedValue({});

    renderUploadForm();
    selectFile("th7_07.rpy");
    await waitFor(() => expect(screen.getByText("MarisaA")).toBeTruthy());
    await waitFor(() => expect(mockedClient.uploadReplay).toHaveBeenCalled());
    fillEmail("user@example.com");
    await waitFor(() => expect(nextStepButton().disabled).toBe(false));
    fireEvent.click(nextStepButton());
    await waitFor(() => expect(screen.getByText("メールを確認してください")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "アップロード画面に戻る" }));

    expect(screen.getByText("th7_07.rpy (0.00KB)")).toBeTruthy();
    expect(mockedClient.createUpload).toHaveBeenCalledTimes(1); // 再アップロードしていない
    await waitFor(() => expect(nextStepButton().disabled).toBe(false));

    fireEvent.click(nextStepButton());
    await waitFor(() => expect(mockedClient.requestMagicLink).toHaveBeenCalledTimes(2));
  });
});

describe("UploadForm のth20の注意書き", () => {
  it("th20のリプレイではデシンクの注意書きを録画前に表示する", async () => {
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: TH20_REPLAY_INFO });
    renderUploadForm();
    selectFile("th20_ud0000.rpy");

    await waitFor(() => expect(screen.getByText(/リプレイずれ/)).toBeTruthy());
  });
});

describe("UploadForm のth10「バグマリ」修正オプション", () => {
  function th10BugfixMarisaBCheckbox(): HTMLInputElement {
    const label = screen
      .getAllByText(/魔理沙Bのショット威力修正を有効にして録画する|shot power fix enabled/)
      .at(0)
      ?.closest("label");
    return label?.querySelector('input[type="checkbox"]') as HTMLInputElement;
  }

  const TH10_MARISA_B_REPLAY_INFO: ReplayInfo = {
    ...SAMPLE_REPLAY_INFO,
    game: "th10",
    character: "MarisaB",
  };

  it("th10かつ魔理沙Bのリプレイなら選択でき、既定はオフ", async () => {
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: TH10_MARISA_B_REPLAY_INFO });
    renderUploadForm();
    selectFile("th10_01.rpy");

    // 選択直後はアップロード処理中でボタン等が非活性になる(busy)ため、その解消
    // (=phaseがreadyになる)を待ってから判定する。
    await waitFor(() => expect(th10BugfixMarisaBCheckbox()?.disabled).toBe(false));
    expect(th10BugfixMarisaBCheckbox().checked).toBe(false);
  });

  it("th10でも魔理沙B以外はグレーアウトする", async () => {
    mockedShared.parseReplayInfo.mockReturnValue({
      ok: true,
      info: { ...TH10_MARISA_B_REPLAY_INFO, character: "ReimuA" },
    });
    renderUploadForm();
    selectFile("th10_01.rpy");

    await waitFor(() => expect(screen.getByText("ReimuA")).toBeTruthy());
    expect(th10BugfixMarisaBCheckbox().disabled).toBe(true);
    expect(th10BugfixMarisaBCheckbox().checked).toBe(false);
    expect(screen.getByText(/東方風神録の魔理沙Bのリプレイでのみ/)).toBeTruthy();
  });

  it("魔理沙Bでもth10以外(th08)はグレーアウトする", async () => {
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: SAMPLE_REPLAY_INFO });
    renderUploadForm();
    selectFile("th7_07.rpy");

    await waitFor(() => expect(screen.getByText("MarisaA")).toBeTruthy());
    expect(th10BugfixMarisaBCheckbox().disabled).toBe(true);
    expect(th10BugfixMarisaBCheckbox().checked).toBe(false);
  });

  it("チェックを入れて送信すると options.th10BugfixMarisaB が true で送られる", async () => {
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: TH10_MARISA_B_REPLAY_INFO });
    mockedClient.requestMagicLink.mockResolvedValue({});
    renderUploadForm();
    selectFile("th10_01.rpy");
    await waitFor(() => expect(th10BugfixMarisaBCheckbox()?.disabled).toBe(false));

    fireEvent.click(th10BugfixMarisaBCheckbox());
    fillEmail("marisa@example.com");
    await waitFor(() => expect(nextStepButton().disabled).toBe(false));
    await act(async () => {
      fireEvent.click(nextStepButton());
    });

    await waitFor(() => expect(screen.getByText("メールを確認してください")).toBeTruthy());
    expect(mockedClient.requestMagicLink).toHaveBeenCalledWith(
      "replays/x.rpy",
      { watermark: true, th10BugfixMarisaB: true, th06ncHighResolution: false },
      "marisa@example.com",
      "ja",
    );
  });

  it("チェック済みで非対応の組み合わせへ差し替えると、送信される値がオフに戻る", async () => {
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: TH10_MARISA_B_REPLAY_INFO });
    renderUploadForm();
    selectFile("th10_01.rpy");
    await waitFor(() => expect(th10BugfixMarisaBCheckbox()?.disabled).toBe(false));
    fireEvent.click(th10BugfixMarisaBCheckbox());
    expect(th10BugfixMarisaBCheckbox().checked).toBe(true);

    // th10・魔理沙B から th08・魔理沙A（非対応の組み合わせ）へ差し替える。
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: SAMPLE_REPLAY_INFO });
    selectFile("th7_07.rpy");
    await waitFor(() => expect(screen.getByText("MarisaA")).toBeTruthy());
    expect(th10BugfixMarisaBCheckbox().checked).toBe(false);

    mockedClient.requestMagicLink.mockResolvedValue({});
    fillEmail("koishi@example.com");
    await waitFor(() => expect(nextStepButton().disabled).toBe(false));
    await act(async () => {
      fireEvent.click(nextStepButton());
    });
    await waitFor(() => expect(screen.getByText("メールを確認してください")).toBeTruthy());
    expect(mockedClient.requestMagicLink).toHaveBeenCalledWith(
      expect.anything(),
      { watermark: true, th10BugfixMarisaB: false, th06ncHighResolution: false },
      "koishi@example.com",
      "ja",
    );
  });
});

describe("UploadForm の録画完了の目安（Issue #317）", () => {
  const TH15_REPLAY_INFO: ReplayInfo = {
    ...SAMPLE_REPLAY_INFO,
    game: "th15",
    estimatedDurationSeconds: 1200,
  };

  it("録画速度・1080pの選択欄は無い", async () => {
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: TH15_REPLAY_INFO });
    renderUploadForm();
    selectFile("th15_01.rpy");
    await waitFor(() => expect(screen.getByText(/録画完了までの目安/)).toBeTruthy());

    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByText(/1080pで録画する/)).toBeNull();
  });

  it("最初の段（th15はGPUの2倍速）で録れたときの目安を表示する", async () => {
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: TH15_REPLAY_INFO });
    renderUploadForm();
    selectFile("th15_01.rpy");

    // 20分のリプレイ: 180 + 1200×1.05÷2 + 1200×0.08 = 906秒 ≒ 15分。
    await waitFor(() => expect(screen.getByText(/録画完了までの目安: 約15分/)).toBeTruthy());
  });

  it("リプレイの尺が分からなければ目安を出さない", async () => {
    mockedShared.parseReplayInfo.mockReturnValue({
      ok: true,
      info: { ...TH15_REPLAY_INFO, estimatedDurationSeconds: null },
    });
    renderUploadForm();
    selectFile("th15_01.rpy");
    await waitFor(() => expect(screen.getByText("th15_01.rpy", { exact: false })).toBeTruthy());

    expect(screen.queryByText(/録画完了までの目安/)).toBeNull();
  });

  it("録画速度を送らず、1080pは常にオフで送信する", async () => {
    mockedShared.parseReplayInfo.mockReturnValue({
      ok: true,
      info: { ...SAMPLE_REPLAY_INFO, game: "th06nc" },
    });
    renderUploadForm();
    selectFile("th6_01.rpy");
    fillEmail("koishi@example.com");
    await waitFor(() => expect(nextStepButton().disabled).toBe(false));
    mockedClient.requestMagicLink.mockResolvedValue({});
    await act(async () => {
      fireEvent.click(nextStepButton());
    });

    expect(mockedClient.requestMagicLink).toHaveBeenCalledWith(
      expect.anything(),
      { watermark: true, th10BugfixMarisaB: false, th06ncHighResolution: false },
      "koishi@example.com",
      "ja",
    );
  });
});
