import { randomUUID } from "node:crypto";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import {
  DEFAULT_LANGUAGE,
  EMAIL_PATTERN,
  isSupportedGame,
  isSupportedLanguage,
  parseReplayInfo,
  supportsSlowMotion,
  supportsTh10BugfixMarisaB,
  type GameId,
  type JobRecord,
  type ReplayInfo,
  type RequestMagicLinkRequest,
  type RequestMagicLinkResponse,
} from "@sattori/shared";
import { loadConfig } from "../config.js";
import { getCachedMonthlyCostUsd } from "../costGuard.js";
import { error, json, parseBody } from "../http.js";
import { deleteJob, PENDING_JOB_TTL_MS, putJob } from "../jobs.js";
import { checkAndRecordRateLimit } from "../rateLimit.js";
import { fetchReplayBytes } from "../replay.js";
import { sendMagicLinkEmail } from "../ses.js";
import { getSettings } from "../settings.js";
import { REPLAY_KEY_PATTERN } from "../uploads.js";

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
  // `replayKey` はサーバー採番の形式が固定（`createPresignedUpload()`）なので、
  // それ以外の値はここで弾く。これは多層防御の1層目に過ぎない——
  // `buildUserData()`（`ec2.ts`）側でもシェルセーフに扱うことで、この検証を
  // すり抜けた値やDB内の既存汚染データが来てもコマンドインジェクションに
  // つながらないようにしている（Issue #127 SEC-1）。
  if (!REPLAY_KEY_PATTERN.test(body.replayKey)) {
    return error(400, "invalid_replay_key", "replayKey の形式が正しくありません");
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

  // `replayInfo` はクライアントが送った任意のJSONをそのまま信用せず、`replayKey`から
  // アップロード済み.rpyを再取得してサーバー側で再パースする（Issue #133 OPS-1）。
  // かつては`body.replayInfo`をそのまま`JobRecord`へ転記していたが、
  // `replayInfo.player`は完了メール本文にそのまま載る（`ses.ts`の`formatReplayInfo()`）
  // ため、第三者のメールアドレスを宛先に指定しつつ`player`へ任意の文面を仕込めば、
  // DKIM署名済み・SPF通過の自ドメインから攻撃者の文面が届く経路になっていた。
  // **これだけでは経路は塞ぎ切れない**——`@sattori/touhou-replay-parser`はタイトルに
  // よって`player`/`character`/`difficulty`をCRLF終端・NUL終端の可変長文字列として
  // 読む実装があり（th08・th11・th20の3タイトル、詳細は`replay-parser`のソース）、
  // 「クライアントの任意JSON」ではなく「CRLFを含まない任意バイト列を偽装した.rpy」
  // を使えば依然として長文を注入できる。そのため`ses.ts`側の`formatReplayInfo()`で
  // 改行・制御文字の除去と長さの打ち切りを追加で行っている（再パース単体はth07以外
  // では不十分な多層防御の1層目に過ぎない）。取得・解析に失敗しても録画自体は継続
  // できるプレビュー用の付随データに過ぎないため、ジョブ作成は落とさず
  // replayInfoをnullとして続行する。
  let replayInfo: ReplayInfo | null = null;
  // `parseReplayInfo()`は「フォーマットとして壊れている」と「フォーマットは読めるが
  // 録画未対応のタイトル」をどちらも`ok:false`にまとめる（プレビューAPI向けに、
  // どちらもユーザーには同じ422として見せればよいため）。後者の場合は検出できた
  // タイトルが`error.game`に残るため、下の`game`判定で"パース失敗（形式不明）"と
  // 混同しないよう別に拾っておく。
  let detectedGame: GameId | null = null;
  try {
    const data = await fetchReplayBytes(config.uploadBucket, body.replayKey, config.maxReplayBytes);
    const result = parseReplayInfo(data);
    if (result.ok) {
      replayInfo = result.info;
      detectedGame = result.info.game;
    } else if (result.error.code === "unsupported_game" && result.error.game) {
      detectedGame = result.error.game;
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "replay_info_reparse_failed",
        replayKey: body.replayKey,
        name: err instanceof Error ? err.name : undefined,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  // `game`/`estimatedDurationSeconds`はクライアントから受け取らず、`replayKey`から
  // サーバー側で再パースした結果だけを使う（Issue #133 OPS-1）。`job.game`は
  // EC2インスタンスタイプ選定（`ec2.ts`の`getCandidateInstanceTypes()`）とワーカー側の
  // 録画スクリプト選択（`GAME`環境変数、`worker/entrypoint.py`）を直接左右するため、
  // クライアント申告を信用すると実際のリプレイと無関係な高コストなインスタンス
  // タイプ（例: th20の`c7i.4xlarge`）を選ばせられてしまう。再パースに失敗した場合
  // （タイトル自体を検出できない破損ファイル等）のみ th07 を既定として続行する
  // （録画自体は等倍前提で継続でき、実際に不整合があればワーカー側で録画が失敗する
  // だけなので、ここでは強く倒さない）。
  const game: GameId = detectedGame ?? "th07";
  if (!isSupportedGame(game)) {
    return error(422, "unsupported_game", "現在このタイトルの録画には対応していません");
  }
  const estimatedDurationSeconds = replayInfo?.estimatedDurationSeconds ?? null;

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
      // th10「バグマリ」修正オプション(Issue #75)。ここも上のslowMotionと同じ理由
      // (Issue #101)でサーバー側の再パース結果に基づいて握り潰す——クライアント申告の
      // `game`/`character`をそのまま信用すると、実際は非対応の組み合わせなのに
      // オプションだけ有効化させられてしまう(=`worker/docs/titles/th10.md`が警告する
      // デシンクの原因を録画側に持ち込む)。`replayInfo`はこの関数内で既にS3から
      // 再取得・再パース済みのものなので、`character`もクライアントの任意入力ではない。
      th10BugfixMarisaB:
        body.options.th10BugfixMarisaB === true &&
        supportsTh10BugfixMarisaB(game, replayInfo?.character ?? null),
    },
    outputPath: null,
    outputPath720p: null,
    outputBytes: null,
    outputBytes720p: null,
    error: null,
    errorCode: null,
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
    estimatedDurationSeconds,
    progress: null,
    previewImagePath: null,
    posterImagePath: null,
    replayInfo,
    pendingExpiresAt: new Date(now.getTime() + PENDING_JOB_TTL_MS).toISOString(),
    retriedToJobId: null,
    retriedFromJobId: null,
    language,
    desyncDetected: null,
    timedOut: null,
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
      replyTo: config.sesReplyToAddress,
      to: job.email as string,
      webBaseUrl: config.webBaseUrl,
      jobId: job.jobId,
      language: job.language,
      replayInfo: job.replayInfo,
      configurationSetName: config.sesConfigurationSetName,
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
