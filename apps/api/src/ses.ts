import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";

const ses = new SESv2Client({});

// プレースホルダの文面。送信元・文言は運用開始前に調整する想定（Issue #9）。
const MAGIC_LINK_EMAIL_SUBJECT = "【Sattori】録画を開始するリンク";
const MAGIC_LINK_EMAIL_BODY = (link: string): string =>
  `Sattoriへのリクエストを受け付けました。\n\n` +
  `以下のリンクをクリックすると録画を開始します（受付期限は24時間です）。\n${link}\n\n` +
  `このメールに心当たりがない場合は、このメールを無視してください。`;

// プレースホルダの文面（Issue #10）。
const COMPLETION_EMAIL_SUBJECT = "【Sattori】録画が完了しました";
const COMPLETION_EMAIL_BODY = (link: string): string =>
  `リプレイの録画が完了しました。\n\n` +
  `以下のリンクから動画をダウンロードできます。\n${link}\n\n` +
  `このメールに心当たりがない場合は、このメールを無視してください。`;

/**
 * ジョブページのURLを組み立てる。jobId自体がこのメールを確認しないと分からない
 * 秘密値として機能するため、URLにはjobId以外のパラメータを含めない（Issue #9）。
 * パスは `/jobs/{jobId}`（Issue #10。フロントエンドの `apps/web/src/App.tsx` の
 * ルーティングと対応する）。
 */
export function buildJobPageUrl(webBaseUrl: string, jobId: string): string {
  return new URL(`/jobs/${encodeURIComponent(jobId)}`, webBaseUrl).toString();
}

/** マジックリンクメールを送信する。 */
export async function sendMagicLinkEmail(params: {
  from: string;
  to: string;
  webBaseUrl: string;
  jobId: string;
}): Promise<void> {
  const link = buildJobPageUrl(params.webBaseUrl, params.jobId);
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
}): Promise<void> {
  const link = buildJobPageUrl(params.webBaseUrl, params.jobId);
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: params.from,
      Destination: { ToAddresses: [params.to] },
      Content: {
        Simple: {
          Subject: { Data: COMPLETION_EMAIL_SUBJECT },
          Body: { Text: { Data: COMPLETION_EMAIL_BODY(link) } },
        },
      },
    }),
  );
}
