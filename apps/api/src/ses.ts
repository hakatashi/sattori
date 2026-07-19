import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";

const ses = new SESv2Client({});

// プレースホルダの文面。送信元・文言は運用開始前に調整する想定（Issue #9）。
const MAGIC_LINK_EMAIL_SUBJECT = "【Sattori】録画を開始するリンク";
const MAGIC_LINK_EMAIL_BODY = (link: string): string =>
  `Sattoriへのリクエストを受け付けました。\n\n` +
  `以下のリンクをクリックすると録画を開始します（24時間有効・1回のみ使用できます）。\n${link}\n\n` +
  `このメールに心当たりがない場合は、このメールを無視してください。`;

export function buildMagicLinkUrl(webBaseUrl: string, jobId: string, token: string): string {
  const url = new URL(webBaseUrl);
  url.searchParams.set("jobId", jobId);
  url.searchParams.set("token", token);
  return url.toString();
}

/** マジックリンクメールを送信する（新規送信・再送の両方から呼ばれる）。 */
export async function sendMagicLinkEmail(params: {
  from: string;
  to: string;
  webBaseUrl: string;
  jobId: string;
  token: string;
}): Promise<void> {
  const link = buildMagicLinkUrl(params.webBaseUrl, params.jobId, params.token);
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: params.from,
      Destination: { ToAddresses: [params.to] },
      Content: {
        Simple: {
          Subject: { Data: MAGIC_LINK_EMAIL_SUBJECT },
          Body: { Text: { Data: MAGIC_LINK_EMAIL_BODY(link) } },
        },
      },
    }),
  );
}
