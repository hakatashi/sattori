import { randomUUID } from "node:crypto";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import {
  DEFAULT_LANGUAGE,
  EMAIL_PATTERN,
  isSupportedGame,
  isSupportedLanguage,
  supportsSlowMotion,
  type GameId,
  type JobRecord,
  type RequestMagicLinkRequest,
  type RequestMagicLinkResponse,
} from "@sattori/shared";
import { loadConfig } from "../config.js";
import { getCachedMonthlyCostUsd } from "../costGuard.js";
import { error, json, parseBody } from "../http.js";
import { deleteJob, PENDING_JOB_TTL_MS, putJob } from "../jobs.js";
import { checkAndRecordRateLimit } from "../rateLimit.js";
import { sendMagicLinkEmail } from "../ses.js";
import { getSettings } from "../settings.js";

/**
 * POST /magic-links
 * マジックリンクメールの送信要求（ページAの「次のステップ」）。
 * この時点で status: "pending" の JobRecord を作成するが、Step Functionsは
 * まだ起動しない。払い出した jobId はレスポンスに含めず、メール本文のリンクとして
 * のみ通知する（jobId自体がメールを確認しないと分からない、録画起動の実質的な
 * 秘密として機能する。`POST /jobs/{jobId}/start` で実際に起動する。Issue #9）。
 */
export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const config = loadConfig();
  const body = parseBody<RequestMagicLinkRequest>(event);
  if (
    !body ||
    typeof body.replayKey !== "string" ||
    !body.options ||
    typeof body.email !== "string"
  ) {
    return error(400, "invalid_request", "replayKey と options と email は必須です");
  }
  if (!EMAIL_PATTERN.test(body.email)) {
    return error(400, "invalid_email", "メールアドレスの形式が正しくありません");
  }

  // ページAはリプレイ解析結果（ReplayInfo.game）を渡してくるが、念のため
  // 未指定なら th07 を既定とする。
  const game: GameId = body.game ?? "th07";
  if (!isSupportedGame(game)) {
    return error(422, "unsupported_game", "現在このタイトルの録画には対応していません");
  }

  // キルスイッチ（Issue #14）。管理者が/adminから手動で全面停止した状態。
  // GetItem1回のみで軽量なためキャッシュせず、切替が即座に反映されるようにする
  // （`settings.ts`参照）。
  const settings = await getSettings(config.settingsTable);
  if (!settings.acceptingNewJobs) {
    return error(
      503,
      "service_paused",
      "現在、新規録画の受付を一時的に停止しています。しばらくしてから再度お試しください。",
    );
  }

  // 月間コストガード（Issue #14）。月間の録画回数ではなく、既存の推定コスト機能
  // （`@sattori/shared`の`estimateJobCost()`）による当月の推定合計額が閾値に達したら
  // 新規受付を止める。自宅サーバーを追加ワーカーとして導入する構想（Issue #49）で
  // ジョブ単価が一様でなくなる見込みのため、回数ではなく金額で判定する。
  // 当月コストの算出はJobsTableの全件Scanを要するため`getCachedMonthlyCostUsd()`が
  // 数分キャッシュする（`costGuard.ts`参照）——閾値到達直後の数分は数件超過して
  // 受け付ける可能性があるが、この推定値自体が請求額そのものではない
  // （AGENTS.md「今後の展開・既知の制約」）ため許容している。
  const currentMonthCostUsd = await getCachedMonthlyCostUsd(config.jobsTable);
  if (currentMonthCostUsd >= settings.monthlyCostLimitUsd) {
    return error(
      503,
      "monthly_cost_limit_reached",
      "今月の推定利用コストが上限に達したため、新規録画の受付を一時的に停止しています。翌月になると自動的に受付を再開します。",
    );
  }

  const { allowed } = await checkAndRecordRateLimit(config.emailRateLimitTable, body.email);
  if (!allowed) {
    return error(
      429,
      "rate_limited",
      "送信回数の上限に達しました。時間をおいて再試行してください",
    );
  }

  const language = isSupportedLanguage(body.language) ? body.language : DEFAULT_LANGUAGE;

  const now = new Date();
  const jobId = randomUUID();
  const job: JobRecord = {
    jobId,
    game,
    replayKey: body.replayKey,
    status: "pending",
    options: {
      watermark: body.options.watermark !== false,
      // 低速録画（Issue #68）は明示的に true を指定されたときだけ有効にする
      // （ウォーターマークと逆で、既定は「しない」）。ここでは自宅ワーカーの
      // 空きを検証しない——実際に録画が始まるのはユーザーがマジックリンクを
      // 開いた後（最大24時間後）で、この時点の可否を確かめても意味がないため。
      // 録画時に自宅ワーカーがいなければ`Launch`がEC2での等倍録画へ静かに
      // フォールバックする（`handlers/sfn/launch.ts`・`workerRouting.ts`）。
      //
      // 一方**タイトルの対応可否は時間で変わらない**ので、ここで握り潰す
      // （Issue #101）。非対応タイトルのまま録画すると、ゲームは等倍で動くのに
      // 後処理だけが等倍化を行って2倍速の動画が出来上がり、しかも元の生動画が
      // 削除される。UI側もグレーアウトするが、ここはその防御線。エラーにはしない
      // ——録画自体は等倍で問題なく行えるため、断るより静かに落とす方がよい。
      slowMotion: body.options.slowMotion === true && supportsSlowMotion(game),
    },
    outputPath: null,
    outputPath720p: null,
    outputBytes: null,
    outputBytes720p: null,
    error: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    launchedAt: null,
    doneAt: null,
    email: body.email,
    // 実行するワーカーの種別は`Launch`が決める（Issue #49）。
    workerKind: null,
    instanceId: null,
    instanceType: null,
    availabilityZone: null,
    spotPricePerHour: null,
    estimatedDurationSeconds: body.estimatedDurationSeconds ?? null,
    progress: null,
    previewImagePath: null,
    replayInfo: body.replayInfo ?? null,
    pendingExpiresAt: new Date(now.getTime() + PENDING_JOB_TTL_MS).toISOString(),
    retriedToJobId: null,
    retriedFromJobId: null,
    language,
  };

  try {
    await putJob(config.jobsTable, job);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "put_job_failed",
        jobId,
        name: err instanceof Error ? err.name : undefined,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return error(500, "internal_error", "処理に失敗しました。時間をおいて再試行してください");
  }

  try {
    await sendMagicLinkEmail({
      from: config.sesFromAddress,
      to: job.email as string,
      webBaseUrl: config.webBaseUrl,
      jobId: job.jobId,
      language: job.language,
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "send_magic_link_email_failed",
        jobId,
        name: err instanceof Error ? err.name : undefined,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    // メールが届かない以上このジョブには誰もアクセスできないため、pendingのまま
    // 残さず削除する（ユーザーは再度「次のステップ」からやり直すことになる）。
    await deleteJob(config.jobsTable, jobId).catch((cleanupErr) => {
      console.error(
        JSON.stringify({
          event: "delete_job_after_email_failure_failed",
          jobId,
          name: cleanupErr instanceof Error ? cleanupErr.name : undefined,
          message: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        }),
      );
    });
    return error(
      502,
      "email_send_failed",
      "メールの送信に失敗しました。時間をおいて再試行してください",
    );
  }

  const response: RequestMagicLinkResponse = {};
  return json(202, response);
};
