import { describe, expect, it, beforeEach } from "vitest";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { mockClient } from "aws-sdk-client-mock";
import { buildJobPageUrl, sendCompletionEmail, sendMagicLinkEmail } from "./ses.js";

const sesMock = mockClient(SESv2Client);

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
    });

    const calls = sesMock.commandCalls(SendEmailCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input.Destination?.ToAddresses).toEqual(["user@example.com"]);
    const body = calls[0]?.args[0].input.Content?.Simple?.Body?.Text?.Data ?? "";
    expect(body).toContain("https://sattori.hakatashi.com/jobs/job-1");
  });

  it("language: enなら英語の文面で送信し、リンクに/enプレフィックスを付ける", async () => {
    await sendCompletionEmail({
      from: "no-reply@sattori.hakatashi.com",
      to: "user@example.com",
      webBaseUrl: "https://sattori.hakatashi.com",
      jobId: "job-1",
      language: "en",
    });

    const calls = sesMock.commandCalls(SendEmailCommand);
    expect(calls[0]?.args[0].input.Content?.Simple?.Subject?.Data).toMatch(/Sattori/);
    expect(calls[0]?.args[0].input.Content?.Simple?.Subject?.Data).not.toMatch(/録画/);
    const body = calls[0]?.args[0].input.Content?.Simple?.Body?.Text?.Data ?? "";
    expect(body).toContain("https://sattori.hakatashi.com/en/jobs/job-1");
  });
});

describe("sendMagicLinkEmail", () => {
  beforeEach(() => {
    sesMock.reset();
    sesMock.on(SendEmailCommand).resolves({});
  });

  it("マジックリンクメールを送信し、本文にジョブページへのリンクを含める", async () => {
    await sendMagicLinkEmail({
      from: "no-reply@sattori.hakatashi.com",
      to: "user@example.com",
      webBaseUrl: "https://sattori.hakatashi.com",
      jobId: "job-1",
      language: "ja",
    });

    const calls = sesMock.commandCalls(SendEmailCommand);
    const body = calls[0]?.args[0].input.Content?.Simple?.Body?.Text?.Data ?? "";
    expect(body).toContain("https://sattori.hakatashi.com/jobs/job-1");
  });

  it("language: enなら英語の文面で送信し、リンクに/enプレフィックスを付ける", async () => {
    await sendMagicLinkEmail({
      from: "no-reply@sattori.hakatashi.com",
      to: "user@example.com",
      webBaseUrl: "https://sattori.hakatashi.com",
      jobId: "job-1",
      language: "en",
    });

    const calls = sesMock.commandCalls(SendEmailCommand);
    expect(calls[0]?.args[0].input.Content?.Simple?.Subject?.Data).toMatch(/Sattori/);
    expect(calls[0]?.args[0].input.Content?.Simple?.Subject?.Data).not.toMatch(/録画/);
    const body = calls[0]?.args[0].input.Content?.Simple?.Body?.Text?.Data ?? "";
    expect(body).toContain("https://sattori.hakatashi.com/en/jobs/job-1");
  });
});
