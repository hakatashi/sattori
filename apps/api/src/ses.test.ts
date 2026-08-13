import { describe, expect, it, beforeEach } from "vitest";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { mockClient } from "aws-sdk-client-mock";
import type { ReplayInfo } from "@sattori/shared";
import { buildJobPageUrl, sendCompletionEmail, sendMagicLinkEmail } from "./ses.js";

const sesMock = mockClient(SESv2Client);

const replayInfo: ReplayInfo = {
  game: "th11",
  player: "koyi",
  date: "26/07/18",
  character: "MarisaC",
  characterNameJa: "魔理沙C",
  characterNameEn: "Marisa C (Nitori)",
  difficulty: "Hard",
  stage: "All",
  score: 182237970,
  cleared: true,
  estimatedDurationSeconds: 1800,
};

/** 送信されたメール本文（1通目）を取り出す。 */
function sentBody(): string {
  return sesMock.commandCalls(SendEmailCommand)[0]?.args[0].input.Content?.Simple?.Body?.Text?.Data ?? "";
}

describe("buildJobPageUrl", () => {
  it("ジョブページのURLを /jobs/{jobId} 形式で組み立てる（既定はja、プレフィックス無し）", () => {
    expect(buildJobPageUrl("https://sattori.hakatashi.com", "abc-123")).toBe(
      "https://sattori.hakatashi.com/jobs/abc-123",
    );
  });

  it("jobIdをパスセグメントとしてエンコードする", () => {
    expect(buildJobPageUrl("https://sattori.hakatashi.com", "a/b")).toBe(
      "https://sattori.hakatashi.com/jobs/a%2Fb",
    );
  });

  it("languageがenなら/enプレフィックスを付ける", () => {
    expect(buildJobPageUrl("https://sattori.hakatashi.com", "abc-123", "en")).toBe(
      "https://sattori.hakatashi.com/en/jobs/abc-123",
    );
  });
});

describe("sendCompletionEmail", () => {
  beforeEach(() => {
    sesMock.reset();
    sesMock.on(SendEmailCommand).resolves({});
  });

  it("完了メールを送信し、本文にジョブページへのリンクを含める", async () => {
    await sendCompletionEmail({
      from: "no-reply@sattori.hakatashi.com",
      to: "user@example.com",
      webBaseUrl: "https://sattori.hakatashi.com",
      jobId: "job-1",
      language: "ja",
      doneAt: null,
      replayInfo: null,
    });

    const calls = sesMock.commandCalls(SendEmailCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input.Destination?.ToAddresses).toEqual(["user@example.com"]);
    expect(sentBody()).toContain("https://sattori.hakatashi.com/jobs/job-1");
  });

  it("language: enなら英語の文面で送信し、リンクに/enプレフィックスを付ける", async () => {
    await sendCompletionEmail({
      from: "no-reply@sattori.hakatashi.com",
      to: "user@example.com",
      webBaseUrl: "https://sattori.hakatashi.com",
      jobId: "job-1",
      language: "en",
      doneAt: null,
      replayInfo: null,
    });

    const calls = sesMock.commandCalls(SendEmailCommand);
    expect(calls[0]?.args[0].input.Content?.Simple?.Subject?.Data).toMatch(/Sattori/);
    expect(calls[0]?.args[0].input.Content?.Simple?.Subject?.Data).not.toMatch(/録画/);
    expect(sentBody()).toContain("https://sattori.hakatashi.com/en/jobs/job-1");
  });

  it("doneAtがあれば本文にダウンロード期限(doneAt+7日)をJST表記で含める", async () => {
    await sendCompletionEmail({
      from: "no-reply@sattori.hakatashi.com",
      to: "user@example.com",
      webBaseUrl: "https://sattori.hakatashi.com",
      jobId: "job-1",
      language: "ja",
      doneAt: "2026-08-12T05:37:00.000Z",
      replayInfo: null,
    });

    // 2026-08-12T05:37Z + 7日 = 2026-08-19T05:37Z = JSTで8月19日 14:37。
    expect(sentBody()).toContain("（動画は2026年8月19日 14:37 JSTまでダウンロードできます）");
  });

  it("language: enならダウンロード期限はUTC表記のままにする", async () => {
    await sendCompletionEmail({
      from: "no-reply@sattori.hakatashi.com",
      to: "user@example.com",
      webBaseUrl: "https://sattori.hakatashi.com",
      jobId: "job-1",
      language: "en",
      doneAt: "2026-08-12T05:37:00.000Z",
      replayInfo: null,
    });

    expect(sentBody()).toContain("available for download until Aug 19, 2026, 5:37 AM UTC");
  });

  it("doneAtが無ければ本文にダウンロード期限の案内を含めない", async () => {
    await sendCompletionEmail({
      from: "no-reply@sattori.hakatashi.com",
      to: "user@example.com",
      webBaseUrl: "https://sattori.hakatashi.com",
      jobId: "job-1",
      language: "ja",
      doneAt: null,
      replayInfo: null,
    });

    expect(sentBody()).not.toContain("までダウンロードできます");
  });

  it("replayInfoがあれば本文にリプレイの概要を含める", async () => {
    await sendCompletionEmail({
      from: "no-reply@sattori.hakatashi.com",
      to: "user@example.com",
      webBaseUrl: "https://sattori.hakatashi.com",
      jobId: "job-1",
      language: "ja",
      doneAt: null,
      replayInfo,
    });

    expect(sentBody()).toContain(
      "【作品タイトル】東方地霊殿 ～ Subterranean Animism.\n" +
        "【プレイヤー名】koyi\n" +
        "【難易度】Hard\n" +
        "【自機タイプ】魔理沙C\n" +
        "【スコア】182,237,970\n",
    );
  });
});

describe("sendMagicLinkEmail", () => {
  beforeEach(() => {
    sesMock.reset();
    sesMock.on(SendEmailCommand).resolves({});
  });

  it("マジックリンクメールを送信し、本文にジョブページへのリンクとリプレイの概要を含める", async () => {
    await sendMagicLinkEmail({
      from: "no-reply@sattori.hakatashi.com",
      to: "user@example.com",
      webBaseUrl: "https://sattori.hakatashi.com",
      jobId: "job-1",
      language: "ja",
      replayInfo,
    });

    expect(sentBody()).toBe(
      "リプレイファイルの録画リクエストを受け付けました。\n" +
        "\n" +
        "【作品タイトル】東方地霊殿 ～ Subterranean Animism.\n" +
        "【プレイヤー名】koyi\n" +
        "【難易度】Hard\n" +
        "【自機タイプ】魔理沙C\n" +
        "【スコア】182,237,970\n" +
        "\n" +
        "以下のリンクをクリックすると録画を開始します（受付期限は24時間です）。\n" +
        "https://sattori.hakatashi.com/jobs/job-1\n" +
        "\n" +
        "このメールに心当たりがない場合は、このメールを無視してください。",
    );
  });

  it("language: enなら英語の文面・英語のキャラ名で送信し、リンクに/enプレフィックスを付ける", async () => {
    await sendMagicLinkEmail({
      from: "no-reply@sattori.hakatashi.com",
      to: "user@example.com",
      webBaseUrl: "https://sattori.hakatashi.com",
      jobId: "job-1",
      language: "en",
      replayInfo,
    });

    expect(sesMock.commandCalls(SendEmailCommand)[0]?.args[0].input.Content?.Simple?.Subject?.Data).toMatch(
      /Sattori/,
    );
    const body = sentBody();
    expect(body).toContain("https://sattori.hakatashi.com/en/jobs/job-1");
    expect(body).toContain("Shot type: Marisa C (Nitori)");
    expect(body).not.toMatch(/録画/);
  });

  it("replayInfoが無ければ概要のブロックごと省く", async () => {
    await sendMagicLinkEmail({
      from: "no-reply@sattori.hakatashi.com",
      to: "user@example.com",
      webBaseUrl: "https://sattori.hakatashi.com",
      jobId: "job-1",
      language: "ja",
      replayInfo: null,
    });

    expect(sentBody()).toBe(
      "リプレイファイルの録画リクエストを受け付けました。\n" +
        "\n" +
        "以下のリンクをクリックすると録画を開始します（受付期限は24時間です）。\n" +
        "https://sattori.hakatashi.com/jobs/job-1\n" +
        "\n" +
        "このメールに心当たりがない場合は、このメールを無視してください。",
    );
  });

  it("解析できなかった項目は行ごと省く", async () => {
    await sendMagicLinkEmail({
      from: "no-reply@sattori.hakatashi.com",
      to: "user@example.com",
      webBaseUrl: "https://sattori.hakatashi.com",
      jobId: "job-1",
      language: "ja",
      replayInfo: {
        ...replayInfo,
        player: "",
        difficulty: null,
        character: null,
        characterNameJa: null,
        characterNameEn: null,
        score: null,
      },
    });

    const body = sentBody();
    expect(body).toContain("【作品タイトル】東方地霊殿 ～ Subterranean Animism.\n\n");
    expect(body).not.toContain("【プレイヤー名】");
    expect(body).not.toContain("【難易度】");
    expect(body).not.toContain("【自機タイプ】");
    expect(body).not.toContain("【スコア】");
  });
});
