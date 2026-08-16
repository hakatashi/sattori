import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import {
  calculateDownloadExpiresAt,
  DEFAULT_LANGUAGE,
  GAME_TITLES,
  localizedCharacterName,
  type ReplayInfo,
  type SupportedLanguage,
} from "@sattori/shared";

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

// 「次のステップ」押下時点で選択されていた言語（`JobRecord.language`）で出し分ける
// （Issue #9・#10、文面はIssue #95で確定）。本文は解析情報のブロック
// （`formatReplayInfo()`）を挟むため、各パートを組み立てる関数として持つ。
const MAGIC_LINK_EMAIL_SUBJECT: Record<SupportedLanguage, string> = {
  ja: "【TouhouSattori】録画を開始するリンク",
  en: "[TouhouSattori] Link to start your recording",
};
const MAGIC_LINK_EMAIL_BODY: Record<
  SupportedLanguage,
  (link: string, replayInfoText: string) => string
> = {
  ja: (link, replayInfoText) =>
    `リプレイファイルの録画リクエストを受け付けました。\n\n` +
    replayInfoText +
    `以下のリンクをクリックすると録画を開始します（受付期限は24時間です）。\n${link}\n\n` +
    `このメールに心当たりがない場合は、このメールを無視してください。`,
  en: (link, replayInfoText) =>
    `We've received a request to record your replay file.\n\n` +
    replayInfoText +
    `Click the link below to start recording (this link expires in 24 hours).\n${link}\n\n` +
    `If you don't recognize this request, please ignore this email.`,
};

const COMPLETION_EMAIL_SUBJECT: Record<SupportedLanguage, string> = {
  ja: "【TouhouSattori】録画が完了しました",
  en: "[TouhouSattori] Your recording is ready",
};
const COMPLETION_EMAIL_BODY: Record<
  SupportedLanguage,
  (link: string, replayInfoText: string, expiresAtText: string | null) => string
> = {
  ja: (link, replayInfoText, expiresAtText) =>
    `リプレイの録画が完了しました。\n\n` +
    replayInfoText +
    `以下のリンクから動画をダウンロードできます。\n${link}\n` +
    (expiresAtText ? `（動画は${expiresAtText}までダウンロードできます）\n` : "") +
    `\nこのメールに心当たりがない場合は、このメールを無視してください。`,
  en: (link, replayInfoText, expiresAtText) =>
    `Your replay recording is complete.\n\n` +
    replayInfoText +
    `You can download the video from the link below.\n${link}\n` +
    (expiresAtText ? `(The video is available for download until ${expiresAtText})\n` : "") +
    `\nIf you don't recognize this request, please ignore this email.`,
};

type ReplayInfoField = "game" | "player" | "difficulty" | "character" | "score";

/** 解析情報ブロックの項目ラベル。 */
const REPLAY_INFO_LABELS: Record<SupportedLanguage, Record<ReplayInfoField, string>> = {
  ja: {
    game: "作品タイトル",
    player: "プレイヤー名",
    difficulty: "難易度",
    character: "自機タイプ",
    score: "スコア",
  },
  en: {
    game: "Title",
    player: "Player",
    difficulty: "Difficulty",
    character: "Shot type",
    score: "Score",
  },
};

/**
 * `ReplayInfo`の自由記述フィールド（player/character/difficulty）を完了メール本文へ
 * 埋め込む前にサニタイズする（Issue #133 OPS-1）。これらのフィールドは
 * `@sattori/touhou-replay-parser`側の実装がタイトルによってCRLF終端・NUL終端の
 * 可変長文字列として読む（`readAnsiString()`/`readNullTerminatedAnsi()`）ため、
 * th08・th11・th20（および th06 の player/date）では**実質無制限の長さ**を
 * 埋め込める（th07のみ固定8バイト・インデックス参照で元から安全）。サーバー側で
 * `replayKey`から再パースするだけでは「クライアントの任意JSON」という経路は塞げても
 * 「CRLFを含まない任意バイト列を偽装した.rpy」という経路は塞げないため、ここで
 * 改行・制御文字の除去と長さの打ち切りを行う。
 */
const MAX_REPLAY_INFO_FIELD_LENGTH = 32;
function sanitizeReplayInfoField(value: string): string | null {
  // 制御文字(改行含む)を意図的に除去する。
  const stripped = Array.from(value)
    .filter((char) => {
      const codePoint = char.codePointAt(0) ?? 0;
      return !(codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f));
    })
    .join("")
    .trim();
  if (stripped.length === 0) {
    return null;
  }
  return stripped.length > MAX_REPLAY_INFO_FIELD_LENGTH
    ? `${stripped.slice(0, MAX_REPLAY_INFO_FIELD_LENGTH)}…`
    : stripped;
}

/**
 * どのリプレイについてのメールなのかを本文冒頭に示すブロックを組み立てる（Issue #95）。
 * メールは録画リクエストから最大24時間後・完了までさらに数十分後に届くため、複数の
 * リプレイを投げたユーザーが受信箱の側でどれのメールか判別できる必要がある。
 * 解析情報が無いジョブ（`replayInfo` が null。旧ジョブや解析に失敗したまま送信した
 * 場合）や、値が取れなかった項目は行ごと省く。
 * 末尾に空行を含めた文字列を返し、`replayInfo` が無ければ空文字列を返す
 * （＝ブロックごと本文から消える）。
 */
function formatReplayInfo(replayInfo: ReplayInfo | null, language: SupportedLanguage): string {
  if (!replayInfo) {
    return "";
  }
  const labels = REPLAY_INFO_LABELS[language];
  const locale = language === "en" ? "en-US" : "ja-JP";
  const characterName = localizedCharacterName(replayInfo, language);
  // 英語の文面でも`fullName`（日本語名＋副題の英語名）をそのまま使う
  // （ページAの解析プレビューと同じ扱い）。
  const rows: [string, string | null][] = [
    [labels.game, GAME_TITLES[replayInfo.game].fullName],
    [labels.player, replayInfo.player ? sanitizeReplayInfoField(replayInfo.player) : null],
    [labels.difficulty, replayInfo.difficulty ? sanitizeReplayInfoField(replayInfo.difficulty) : null],
    [labels.character, characterName ? sanitizeReplayInfoField(characterName) : null],
    [labels.score, replayInfo.score === null ? null : replayInfo.score.toLocaleString(locale)],
  ];
  const lines = rows
    .filter((row): row is [string, string] => row[1] !== null)
    .map(([label, value]) => (language === "en" ? `${label}: ${value}` : `【${label}】${value}`));
  return `${lines.join("\n")}\n\n`;
}

/**
 * ダウンロード期限を完了メール用に整形する。メール本文はブラウザ（ジョブ画面）と
 * 異なり閲覧者のタイムゾーンが分からないため、タイムゾーンを明示する
 * （`timeZoneName: "short"` で末尾に "JST" / "UTC" が付く）。日本語の文面は読み手が
 * 日本在住である前提でJST、英語の文面は特定の地域を想定できないためUTCで表記する
 * （Issue #95）。
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
    minute: "2-digit",
    timeZone: language === "en" ? "UTC" : "Asia/Tokyo",
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
  /** 本文冒頭に載せるリプレイの解析情報（`JobRecord.replayInfo`）。無ければ省く。 */
  replayInfo: ReplayInfo | null;
  /**
   * SES `ConfigurationSet` 名（`ApiConfig.sesConfigurationSetName`）。バウンス・苦情・
   * 拒否イベントをSNS経由で運用アラートへ流すための紐付け（Issue #133 OPS-1）。
   */
  configurationSetName: string;
}): Promise<void> {
  const link = buildJobPageUrl(params.webBaseUrl, params.jobId, params.language);
  const replayInfoText = formatReplayInfo(params.replayInfo, params.language);
  await sesClient().send(
    new SendEmailCommand({
      FromEmailAddress: params.from,
      Destination: { ToAddresses: [params.to] },
      ConfigurationSetName: params.configurationSetName,
      Content: {
        Simple: {
          Subject: { Data: MAGIC_LINK_EMAIL_SUBJECT[params.language] },
          Body: { Text: { Data: MAGIC_LINK_EMAIL_BODY[params.language](link, replayInfoText) } },
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
  /** 本文冒頭に載せるリプレイの解析情報（`JobRecord.replayInfo`）。無ければ省く。 */
  replayInfo: ReplayInfo | null;
  /**
   * SES `ConfigurationSet` 名（`ApiConfig.sesConfigurationSetName`）。バウンス・苦情・
   * 拒否イベントをSNS経由で運用アラートへ流すための紐付け（Issue #133 OPS-1）。
   */
  configurationSetName: string;
}): Promise<void> {
  const link = buildJobPageUrl(params.webBaseUrl, params.jobId, params.language);
  const replayInfoText = formatReplayInfo(params.replayInfo, params.language);
  const expiresAt = calculateDownloadExpiresAt(params.doneAt);
  const expiresAtText = expiresAt ? formatExpiresAtForEmail(expiresAt, params.language) : null;
  await sesClient().send(
    new SendEmailCommand({
      FromEmailAddress: params.from,
      Destination: { ToAddresses: [params.to] },
      ConfigurationSetName: params.configurationSetName,
      Content: {
        Simple: {
          Subject: { Data: COMPLETION_EMAIL_SUBJECT[params.language] },
          Body: {
            Text: { Data: COMPLETION_EMAIL_BODY[params.language](link, replayInfoText, expiresAtText) },
          },
        },
      },
    }),
  );
}
