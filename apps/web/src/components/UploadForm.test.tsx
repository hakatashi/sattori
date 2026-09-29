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
  getWorkerAvailability: vi.fn(),
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
  // UploadForm はマウント時に必ず自宅ワーカーの空き状況を引く。既定は「いない」
  // （＝低速録画は選べない）とし、必要なテストだけが上書きする。
  mockedClient.getWorkerAvailability.mockResolvedValue({ available: false, capabilities: [] });
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
      { watermark: true, slowMotion: false, th10BugfixMarisaB: false, th06ncHighResolution: false, recordingSpeed: 1 },
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

/**
 * 低速録画（Issue #68）の詳細設定。要件は「低速録画に対応したタイトル（Issue #101）で、
 * かつ自宅ワーカーが利用可能なとき、かつその場合に限り選べる」「選べるならth20だけ
 * 既定オン」「選べないならグレーアウト」。
 */
describe("UploadForm の低速録画オプション", () => {
  function slowMotionCheckbox(): HTMLInputElement | null {
    const labels = screen
      .queryAllByText(/低速録画で品質を優先する|Prioritize quality/)
      .map((el) => el.closest("label"))
      .filter((label): label is HTMLLabelElement => label !== null);
    const label = labels[0];
    return (label?.querySelector('input[type="checkbox"]') as HTMLInputElement) ?? null;
  }

  it("自宅ワーカーが使えなくても、EC2低速録画対応タイトル(th20)なら選択でき、既定でオンになる（Issue #245）", async () => {
    mockedClient.getWorkerAvailability.mockResolvedValue({ available: false, capabilities: [] });
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: TH20_REPLAY_INFO });
    renderUploadForm();
    selectFile("th20_ud0000.rpy");

    await waitFor(() => expect(slowMotionCheckbox()?.checked).toBe(true));
    expect(slowMotionCheckbox()?.disabled).toBe(false);
  });

  it("自宅ワーカーが低速録画に対応していれば、th20は既定でオンになる", async () => {
    mockedClient.getWorkerAvailability.mockResolvedValue({
      available: true,
      capabilities: ["slow-motion-recording"],
    });
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: TH20_REPLAY_INFO });
    renderUploadForm();
    selectFile("th20_ud0000.rpy");

    await waitFor(() => expect(slowMotionCheckbox()?.checked).toBe(true));
    expect(slowMotionCheckbox()?.disabled).toBe(false);
  });

  it("低速録画に未対応のタイトルは、自宅ワーカーが使えてもグレーアウトする（Issue #101）", async () => {
    mockedClient.getWorkerAvailability.mockResolvedValue({
      available: true,
      capabilities: ["slow-motion-recording"],
    });
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: SAMPLE_REPLAY_INFO });
    renderUploadForm();
    selectFile("th7_07.rpy");

    await waitFor(() => expect(screen.getByText("MarisaA")).toBeTruthy());
    expect(slowMotionCheckbox()?.checked).toBe(false);
    expect(slowMotionCheckbox()?.disabled).toBe(true);
    expect(screen.getByText(/まだ低速録画に対応していない/)).toBeTruthy();
  });

  it("非対応タイトルへ差し替えたら、チェック済みでも送信される値がオフに戻る", async () => {
    mockedClient.getWorkerAvailability.mockResolvedValue({
      available: true,
      capabilities: ["slow-motion-recording"],
    });
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: TH20_REPLAY_INFO });
    renderUploadForm();
    selectFile("th20_ud0000.rpy");
    await waitFor(() => expect(slowMotionCheckbox()?.checked).toBe(true));

    // th20（既定オン）から th07（未対応）へ差し替える。
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: SAMPLE_REPLAY_INFO });
    selectFile("th7_07.rpy");
    await waitFor(() => expect(screen.getByText("MarisaA")).toBeTruthy());
    expect(slowMotionCheckbox()?.checked).toBe(false);

    mockedClient.requestMagicLink.mockResolvedValue({});
    fillEmail("koishi@example.com");
    await waitFor(() => expect(nextStepButton().disabled).toBe(false));
    await act(async () => {
      fireEvent.click(nextStepButton());
    });
    await waitFor(() => expect(screen.getByText("メールを確認してください")).toBeTruthy());
    expect(mockedClient.requestMagicLink).toHaveBeenCalledWith(
      expect.anything(),
      { watermark: true, slowMotion: false, th10BugfixMarisaB: false, th06ncHighResolution: false, recordingSpeed: 1 },
      "koishi@example.com",
      "ja",
    );
  });

  it("th20のリプレイではデシンクの注意書きを録画前に表示する", async () => {
    mockedClient.getWorkerAvailability.mockResolvedValue({ available: false, capabilities: [] });
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: TH20_REPLAY_INFO });
    renderUploadForm();
    selectFile("th20_ud0000.rpy");

    await waitFor(() => expect(screen.getByText(/リプレイずれ/)).toBeTruthy());
    // 処理落ちの注意自体は常に出る。
    expect(screen.getByText(/描画が重く/)).toBeTruthy();
  });

  it("低速録画が有効なら、低速録画をすすめる案内は出さない", async () => {
    mockedClient.getWorkerAvailability.mockResolvedValue({
      available: true,
      capabilities: ["slow-motion-recording"],
    });
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: TH20_REPLAY_INFO });
    renderUploadForm();
    selectFile("th20_ud0000.rpy");

    // 注意書き自体はリプレイの解析直後（＝自宅ワーカーの空き状況を引く前）に出るので、
    // 低速録画が実際にオンになるまで待ってから案内の有無を見る。
    await waitFor(() => expect(slowMotionCheckbox()?.checked).toBe(true));
    expect(screen.getByText(/リプレイずれ/)).toBeTruthy();
    // 処理落ちの注意自体は常に出すが、低速録画をすすめる一文だけを落とす。
    expect(screen.getByText(/描画が重く/)).toBeTruthy();
    expect(screen.queryByText(/ある程度の改善/)).toBeNull();
  });

  it("低速録画のチェックを外した場合は、低速録画をすすめる案内を表示する", async () => {
    mockedClient.getWorkerAvailability.mockResolvedValue({ available: false, capabilities: [] });
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: TH20_REPLAY_INFO });
    renderUploadForm();
    selectFile("th20_ud0000.rpy");

    await waitFor(() => {
      const cb = slowMotionCheckbox();
      expect(cb).not.toBeNull();
      expect(cb?.disabled).toBe(false);
      expect(cb?.checked).toBe(true);
    });

    // チェックを外す
    fireEvent.click(slowMotionCheckbox()!);
    expect(slowMotionCheckbox()?.checked).toBe(false);

    // 低速録画がオフなので、低速録画で改善できる旨の案内が出る。
    expect(screen.getByText(/ある程度の改善/)).toBeTruthy();
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

  it("魔理沙Bでもth10以外(th07)はグレーアウトする", async () => {
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
      { watermark: true, slowMotion: false, th10BugfixMarisaB: true, th06ncHighResolution: false, recordingSpeed: 1 },
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

    // th10・魔理沙B から th07・魔理沙A（非対応の組み合わせ）へ差し替える。
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
      { watermark: true, slowMotion: false, th10BugfixMarisaB: false, th06ncHighResolution: false, recordingSpeed: 1 },
      "koishi@example.com",
      "ja",
    );
  });
});

describe("UploadForm のth06nc 1080p録画オプション", () => {
  function th06ncHighResolutionCheckbox(): HTMLInputElement {
    const label = screen
      .getAllByText(/1080pで録画する|Record.*1080p/)
      .at(0)
      ?.closest("label");
    return label?.querySelector('input[type="checkbox"]') as HTMLInputElement;
  }

  const TH06NC_REPLAY_INFO: ReplayInfo = {
    ...SAMPLE_REPLAY_INFO,
    game: "th06nc",
  };

  it("th06ncのリプレイなら選択でき、既定はオフ(720p)", async () => {
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: TH06NC_REPLAY_INFO });
    renderUploadForm();
    selectFile("th6_01.rpy");

    await waitFor(() => expect(th06ncHighResolutionCheckbox()?.disabled).toBe(false));
    expect(th06ncHighResolutionCheckbox().checked).toBe(false);
  });

  it("th06nc以外はグレーアウトする", async () => {
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: SAMPLE_REPLAY_INFO });
    renderUploadForm();
    selectFile("th7_07.rpy");

    await waitFor(() => expect(screen.getByText("MarisaA")).toBeTruthy());
    expect(th06ncHighResolutionCheckbox().disabled).toBe(true);
    expect(th06ncHighResolutionCheckbox().checked).toBe(false);
    expect(screen.getByText(/New Classicのリプレイでのみ|New Classic replays/)).toBeTruthy();
  });

  it("チェックを入れて送信すると options.th06ncHighResolution が true で送られる", async () => {
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: TH06NC_REPLAY_INFO });
    mockedClient.requestMagicLink.mockResolvedValue({});
    renderUploadForm();
    selectFile("th6_01.rpy");
    await waitFor(() => expect(th06ncHighResolutionCheckbox()?.disabled).toBe(false));

    fireEvent.click(th06ncHighResolutionCheckbox());
    fillEmail("reimu@example.com");
    await waitFor(() => expect(nextStepButton().disabled).toBe(false));
    await act(async () => {
      fireEvent.click(nextStepButton());
    });

    await waitFor(() => expect(screen.getByText("メールを確認してください")).toBeTruthy());
    expect(mockedClient.requestMagicLink).toHaveBeenCalledWith(
      "replays/x.rpy",
      { watermark: true, slowMotion: false, th10BugfixMarisaB: false, th06ncHighResolution: true, recordingSpeed: 1 },
      "reimu@example.com",
      "ja",
    );
  });

  it("チェック済みで非対応タイトルへ差し替えると、送信される値がオフに戻る", async () => {
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: TH06NC_REPLAY_INFO });
    renderUploadForm();
    selectFile("th6_01.rpy");
    await waitFor(() => expect(th06ncHighResolutionCheckbox()?.disabled).toBe(false));
    fireEvent.click(th06ncHighResolutionCheckbox());
    expect(th06ncHighResolutionCheckbox().checked).toBe(true);

    // th06nc から th07（非対応タイトル）へ差し替える。
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: SAMPLE_REPLAY_INFO });
    selectFile("th7_07.rpy");
    await waitFor(() => expect(screen.getByText("MarisaA")).toBeTruthy());
    expect(th06ncHighResolutionCheckbox().checked).toBe(false);

    mockedClient.requestMagicLink.mockResolvedValue({});
    fillEmail("koishi@example.com");
    await waitFor(() => expect(nextStepButton().disabled).toBe(false));
    await act(async () => {
      fireEvent.click(nextStepButton());
    });
    await waitFor(() => expect(screen.getByText("メールを確認してください")).toBeTruthy());
    expect(mockedClient.requestMagicLink).toHaveBeenCalledWith(
      expect.anything(),
      { watermark: true, slowMotion: false, th10BugfixMarisaB: false, th06ncHighResolution: false, recordingSpeed: 1 },
      "koishi@example.com",
      "ja",
    );
  });
});

describe("UploadForm の録画速度オプション（Issue #288）", () => {
  const TH15_REPLAY_INFO: ReplayInfo = {
    ...SAMPLE_REPLAY_INFO,
    game: "th15",
    estimatedDurationSeconds: 1200,
  };

  function speedRadio(speed: number): HTMLInputElement {
    return screen.getByRole("radio", { name: new RegExp(`^${speed}倍速`) }) as HTMLInputElement;
  }

  /** `fieldset`の`disabled`は子の`input.disabled`プロパティへは反映されないため、`:disabled`で判定する。 */
  function isDisabled(input: HTMLInputElement): boolean {
    return input.matches(":disabled");
  }

  it("公開済みタイトル(th15)ではおすすめの2倍速が既定で選ばれ、推定時間が表示される", async () => {
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: TH15_REPLAY_INFO });
    renderUploadForm();
    selectFile("th15_01.rpy");

    await waitFor(() => expect(isDisabled(speedRadio(2))).toBe(false));
    expect(speedRadio(2).checked).toBe(true);
    expect(speedRadio(2).closest("label")?.textContent).toContain("おすすめ");
    // 20分のリプレイ: 1倍速より2倍速の方が短い推定時間になる。
    const minutesOf = (speed: number) =>
      Number(/約(\d+)分/.exec(speedRadio(speed).closest("label")?.textContent ?? "")?.[1]);
    expect(minutesOf(2)).toBeLessThan(minutesOf(1));
    expect(minutesOf(4)).toBeLessThan(minutesOf(2));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("おすすめより速い速度を選ぶとタイトル名入りの警告を出す", async () => {
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: TH15_REPLAY_INFO });
    renderUploadForm();
    selectFile("th15_01.rpy");
    await waitFor(() => expect(isDisabled(speedRadio(3))).toBe(false));

    fireEvent.click(speedRadio(3));

    expect(speedRadio(3).checked).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain(
      "東方紺珠伝で推奨される録画速度より速い録画速度が選択されました",
    );
    fireEvent.click(speedRadio(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("選んだ速度で送信する", async () => {
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: TH15_REPLAY_INFO });
    renderUploadForm();
    selectFile("th15_01.rpy");
    await waitFor(() => expect(isDisabled(speedRadio(4))).toBe(false));
    fireEvent.click(speedRadio(4));
    fillEmail("koishi@example.com");
    await waitFor(() => expect(nextStepButton().disabled).toBe(false));
    await act(async () => {
      fireEvent.click(nextStepButton());
    });

    expect(mockedClient.requestMagicLink).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ recordingSpeed: 4, slowMotion: false }),
      "koishi@example.com",
      "ja",
    );
  });

  it("未公開のタイトルでは選択肢を無効にし、等倍で送信する", async () => {
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: SAMPLE_REPLAY_INFO });
    renderUploadForm();
    selectFile("th7_07.rpy");
    await waitFor(() => expect(nextStepButton().disabled).toBe(true));
    await waitFor(() => expect(screen.getByText("このタイトルは現在、1倍速での録画のみに対応しています。")).toBeTruthy());

    expect(isDisabled(speedRadio(2))).toBe(true);
    expect(speedRadio(1).checked).toBe(true);
  });

  it("別のリプレイを選び直すとおすすめに戻る", async () => {
    mockedShared.parseReplayInfo.mockReturnValue({ ok: true, info: TH15_REPLAY_INFO });
    renderUploadForm();
    selectFile("th15_01.rpy");
    await waitFor(() => expect(isDisabled(speedRadio(4))).toBe(false));
    fireEvent.click(speedRadio(4));

    selectFile("th15_02.rpy");
    await waitFor(() => expect(speedRadio(2).checked).toBe(true));
  });
});
