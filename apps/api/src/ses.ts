import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { calculateDownloadExpiresAt, DEFAULT_LANGUAGE, type SupportedLanguage } from "@sattori/shared";

// SESクライアントは遅延生成する。Lambda実行リージョン(eu-south-2)にはSESが
// 存在しないため、`SES_REGION`環境変数(infra/lib/sattori-stack.tsが設定、
// 実体は`SattoriEdgeStack`のus-east-1)を明示してクライアントを向ける必要がある。
// モジュール読み込み時点でこれを解決すると、テスト側の`vi.stubEnv`より先に
// 評価されてしまう順序依存が生まれるため、初回呼び出し時まで生成を遅らせる。
let _ses: SESv2Client | null = null;
function sesClient(): SESv2Client {
  if (!_ses) {
    _ses = new SESv2Client({ region: process.env.SES_REGION ?? "us-east-1" });
  }
  return _ses;
}

// プレースホルダの文面。送信元・文言は運用開始前に調整する想定（Issue #9）。
// 「次のステップ」押下時点で選択されていた言語（`JobRecord.language`）で出し分ける。
const MAGIC_LINK_EMAIL_SUBJECT: Record<SupportedLanguage, string> = {
  ja: "【TouhouSattori】録画を開始するリンク",
  en: "[TouhouSattori] Link to start your recording",
};
const MAGIC_LINK_EMAIL_BODY: Record<SupportedLanguage, (link: string) => string> = {
  ja: (link) =>
    `TouhouSattoriへのリクエストを受け付けました。\n\n` +
    `以下のリンクをクリックすると録画を開始します（受付期限は24時間です）。\n${link}\n\n` +
    `このメールに心当たりがない場合は、このメールを無視してください。`,
  en: (link) =>
    `We've received your request on TouhouSattori.\n\n` +
    `Click the link below to start recording (this link expires in 24 hours).\n${link}\n\n` +
    `If you don't recognize this request, please ignore this email.`,
};

// プレースホルダの文面（Issue #10）。
const COMPLETION_EMAIL_SUBJECT: Record<SupportedLanguage, string> = {
  ja: "【TouhouSattori】録画が完了しました",
  en: "[TouhouSattori] Your recording is ready",
};
const COMPLETION_EMAIL_BODY: Record<SupportedLanguage, (link: string, expiresAtText: string | null) => string> = {
  ja: (link, expiresAtText) =>
    `リプレイの録画が完了しました。\n\n` +
    `以下のリンクから動画をダウンロードできます。\n${link}\n` +
    (expiresAtText ? `（動画は${expiresAtText}までダウンロードできます）\n` : "") +
    `\nこのメールに心当たりがない場合は、このメールを無視してください。`,
  en: (link, expiresAtText) =>
    `Your replay recording is complete.\n\n` +
    `You can download the video from the link below.\n${link}\n` +
    (expiresAtText ? `(The video will be available for download until ${expiresAtText})\n` : "") +
    `\nIf you don't recognize this request, please ignore this email.`,
};

/**
 * ダウンロード期限を完了メール用に整形する。メール本文はブラウザ（ジョブ画面）と
 * 異なり閲覧者のタイムゾーンが分からないため、常にUTC表記で明示する
 * （`timeZoneName: "short"` で末尾に"UTC"が付く）。
 */
function formatExpiresAtForEmail(expiresAt: string, language: SupportedLanguage): string {
  const locale = language === "en" ? "en-US" : "ja-JP";
  // dateStyle/timeStyle と timeZoneName は ECMA-402 上同時指定できないため、
  // 個別フィールド指定で組み立てる。
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(expiresAt));
}

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
  await sesClient().send(
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
 * 含めず、常に最新の状態を返すジョブページへのリンクを案内する。ダウンロード期限
 * （出力バケットのライフサイクルルール由来）は `doneAt` から算出し、あわせて案内する。
 */
export async function sendCompletionEmail(params: {
  from: string;
  to: string;
  webBaseUrl: string;
  jobId: string;
  language: SupportedLanguage;
  /** JobRecord.doneAt（status "done" 遷移時刻、ISO 8601）。未設定なら期限は案内しない。 */
  doneAt: string | null;
}): Promise<void> {
  const link = buildJobPageUrl(params.webBaseUrl, params.jobId, params.language);
  const expiresAt = calculateDownloadExpiresAt(params.doneAt);
  const expiresAtText = expiresAt ? formatExpiresAtForEmail(expiresAt, params.language) : null;
  await sesClient().send(
    new SendEmailCommand({
      FromEmailAddress: params.from,
      Destination: { ToAddresses: [params.to] },
      Content: {
        Simple: {
          Subject: { Data: COMPLETION_EMAIL_SUBJECT[params.language] },
          Body: { Text: { Data: COMPLETION_EMAIL_BODY[params.language](link, expiresAtText) } },
        },
      },
    }),
  );
}
