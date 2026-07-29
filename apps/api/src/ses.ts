import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { DEFAULT_LANGUAGE, type SupportedLanguage } from "@sattori/shared";

const ses = new SESv2Client({});

// プレースホルダの文面。送信元・文言は運用開始前に調整する想定（Issue #9）。
// 「次のステップ」押下時点で選択されていた言語（`JobRecord.language`）で出し分ける。
const MAGIC_LINK_EMAIL_SUBJECT: Record<SupportedLanguage, string> = {
  ja: "【Sattori】録画を開始するリンク",
  en: "[Sattori] Link to start your recording",
};
const MAGIC_LINK_EMAIL_BODY: Record<SupportedLanguage, (link: string) => string> = {
  ja: (link) =>
    `Sattoriへのリクエストを受け付けました。\n\n` +
    `以下のリンクをクリックすると録画を開始します（受付期限は24時間です）。\n${link}\n\n` +
    `このメールに心当たりがない場合は、このメールを無視してください。`,
  en: (link) =>
    `We've received your request on Sattori.\n\n` +
    `Click the link below to start recording (this link expires in 24 hours).\n${link}\n\n` +
    `If you don't recognize this request, please ignore this email.`,
};

// プレースホルダの文面（Issue #10）。
const COMPLETION_EMAIL_SUBJECT: Record<SupportedLanguage, string> = {
  ja: "【Sattori】録画が完了しました",
  en: "[Sattori] Your recording is ready",
};
const COMPLETION_EMAIL_BODY: Record<SupportedLanguage, (link: string) => string> = {
  ja: (link) =>
    `リプレイの録画が完了しました。\n\n` +
    `以下のリンクから動画をダウンロードできます。\n${link}\n\n` +
    `このメールに心当たりがない場合は、このメールを無視してください。`,
  en: (link) =>
    `Your replay recording is complete.\n\n` +
    `You can download the video from the link below.\n${link}\n\n` +
    `If you don't recognize this request, please ignore this email.`,
};

/**
 * ジョブページのURLを組み立てる。jobId自体がこのメールを確認しないと分からない
 * 秘密値として機能するため、URLにはjobId以外のパラメータを含めない（Issue #9）。
 * パスは `/jobs/{jobId}`（Issue #10。フロントエンドの `apps/web/src/App.tsx` の
 * ルーティングと対応する）。`language` が "en" の場合はフロントエンドの
 * `toLocalizedPath` と同じ規則で `/en` プレフィックスを付け、メールの文面と
 * リンク先ジョブページの言語を一致させる（既定言語jaはプレフィックス無し）。
 */
export function buildJobPageUrl(
  webBaseUrl: string,
  jobId: string,
  language: SupportedLanguage = DEFAULT_LANGUAGE,
): string {
  const prefix = language === "en" ? "/en" : "";
  return new URL(`${prefix}/jobs/${encodeURIComponent(jobId)}`, webBaseUrl).toString();
}

/** マジックリンクメールを送信する。 */
export async function sendMagicLinkEmail(params: {
  from: string;
  to: string;
  webBaseUrl: string;
  jobId: string;
  language: SupportedLanguage;
}): Promise<void> {
  const link = buildJobPageUrl(params.webBaseUrl, params.jobId, params.language);
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: params.from,
      Destination: { ToAddresses: [params.to] },
      Content: {
        Simple: {
          Subject: { Data: MAGIC_LINK_EMAIL_SUBJECT[params.language] },
          Body: { Text: { Data: MAGIC_LINK_EMAIL_BODY[params.language](link) } },
        },
      },
    }),
  );
}

/**
 * 録画完了メールを送信する（Issue #10）。ジョブが "done" に遷移したタイミングで
 * DynamoDB Streams 経由（`handlers/sendCompletionEmail.ts`）で1回だけ呼ばれる。
 * ダウンロードURL（720p/元解像度）はジョブの状態次第で変わり得るため直接メールに
 * 含めず、常に最新の状態を返すジョブページへのリンクを案内する。
 */
export async function sendCompletionEmail(params: {
  from: string;
  to: string;
  webBaseUrl: string;
  jobId: string;
  language: SupportedLanguage;
}): Promise<void> {
  const link = buildJobPageUrl(params.webBaseUrl, params.jobId, params.language);
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: params.from,
      Destination: { ToAddresses: [params.to] },
      Content: {
        Simple: {
          Subject: { Data: COMPLETION_EMAIL_SUBJECT[params.language] },
          Body: { Text: { Data: COMPLETION_EMAIL_BODY[params.language](link) } },
        },
      },
    }),
  );
}
