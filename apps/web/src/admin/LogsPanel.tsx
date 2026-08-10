import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isTerminalStatus } from "@sattori/shared";
import type { AdminLogEvent, JobStatus, WorkerKind } from "@sattori/shared";
import { AdminUnauthorizedError, fetchAdminLogs } from "./adminApi.ts";
import { useAdminAuth } from "./AdminAuthContext.ts";
import styles from "./LogsPanel.module.css";

interface Props {
  jobId: string;
  /**
   * ジョブの現在のstatus。終端(`done`/`failed`)でなければログが増え続けるため、
   * 自動更新の対象にする。この値は`JobDetailPage`が取得した時点のもので、画面を
   * 開いたまま録画が完了しても更新されない（＝完了後もしばらく自動更新が続く）が、
   * 空振りのポーリングが数回増えるだけなので許容する。
   */
  status: JobStatus;
  /**
   * ワーカーの種別（Issue #49）。ログの中身はどちらも同じ（自宅ワーカーも
   * `home-worker/src/logShipper.ts`がEC2と同じロググループ・同じストリーム名へ
   * 転送する）が、**ログが見つからないときの原因の説明だけが違う**ため受け取る。
   */
  workerKind: WorkerKind | null;
  instanceId: string | null;
  /**
   * 720p変換のffmpeg生ログ(S3署名付きGET URL)。ワーカーが再デプロイ済みのジョブでは
   * CloudWatchへ流さずここへ退避されるため、下のチェックボックス(過去のジョブ向け、
   * ノートを参照)ではなくこちらが主なアクセス手段になる(Issue #58フォローアップ)。
   * 未取得/削除済み(3日で自動削除)なら null。
   */
  ffmpegLogUrl: string | null;
}

/** 実行中ジョブのログを取り直す間隔(ミリ秒)。 */
const REFRESH_INTERVAL_MS = 10_000;

/**
 * 「末尾までスクロールしている」と見なす許容誤差(px)。ブラウザのサブピクセル
 * 丸めで`scrollTop`が数px足りないことがあるため、厳密な一致では判定しない。
 */
const BOTTOM_THRESHOLD_PX = 8;

function formatTimestamp(ts: number | null): string {
  if (ts === null) {
    return "-";
  }
  return new Date(ts).toLocaleString("ja-JP");
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "不明なエラーが発生しました";
}

/**
 * `worker/upscale.py`が720p変換中のffmpeg進捗行(frame=/fps=/bitrate=等、`-progress`の
 * out_time_ms以外の全キー)を`[ffmpeg] `プレフィックス付きで1行ずつログに流しているため、
 * 1ジョブで数千行に達し他のログを埋もれさせる。exit_code等の要約行
 * （`ffmpeg(映像) exit_code=...`）は別プレフィックスでノイズではないため対象外にする。
 * `[ffmpeg] `は`worker/entrypoint.py`の`log()`が付ける`[entrypoint HH:MM:SS] `に
 * 後続する形で書き込まれ先頭には来ない(実例:
 * `[entrypoint 10:12:57] [ffmpeg] frame=97119`)ため`startsWith`ではなく`includes`で判定する。
 */
function isFfmpegNoise(message: string): boolean {
  return message.includes("[ffmpeg] ");
}

/**
 * 自動更新で取り直した最新ページ`incoming`を、表示中の`prev`へ継ぎ足す。
 *
 * `GetLogEvents`のイベントには識別子が無いので、`(timestamp, message)`が一致する
 * 位置を`prev`の末尾側から探して重なりと見なし、そこから後ろを`incoming`で
 * 置き換える。「さらに古いログを読み込む」で積んだ履歴を毎回の自動更新で
 * 捨てないためのマージであり、厳密な同一性判定ではない（同一ミリ秒に同一文言が
 * 出た場合はずれうるが、実害は表示が数行重複する程度）。
 *
 * 重なりが見つからない＝前回の更新から`LOG_EVENTS_LIMIT`件以上流れて履歴が
 * 途切れている場合は、間を埋められないので`incoming`だけにする（`replaced`）。
 * 呼び出し側はこのとき「さらに古いログ」のカーソルも取り直す必要がある。
 */
export function mergeTailEvents(
  prev: AdminLogEvent[],
  incoming: AdminLogEvent[],
): { events: AdminLogEvent[]; replaced: boolean } {
  if (prev.length === 0) {
    return { events: incoming, replaced: true };
  }
  const first = incoming[0];
  if (!first) {
    // 取得0件。表示済みのログを消してしまわないよう、そのまま据え置く。
    return { events: prev, replaced: false };
  }
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const event = prev[i];
    if (event && event.timestamp === first.timestamp && event.message === first.message) {
      return { events: [...prev.slice(0, i), ...incoming], replaced: false };
    }
  }
  return { events: incoming, replaced: true };
}

/**
 * ワーカーコンテナのCloudWatch Logs(`GET /admin/jobs/{jobId}/logs`、Issue #58)。
 * ロググループは固定(`/sattori/worker`)、ログストリーム名はjobIdなのでAPI側で解決する。
 * 「さらに古いログを読み込む」は前ページの`nextBackwardToken`を`cursor`に渡して先頭へ
 * 積み増す(`useAdminResource`は依存配列変更での再取得しか扱えないため、ここだけ自前で状態管理する)。
 *
 * 初回読み込み後は末尾（最新行）まで自動スクロールする。さらに、ジョブが実行中で
 * **かつ表示が末尾にある間だけ**`REFRESH_INTERVAL_MS`ごとに最新ページを取り直して
 * 追尾する（`tail -f`相当）。履歴を遡って読んでいる最中に勝手に末尾へ飛ばされる
 * のを避けるため、末尾判定はstateではなく毎回DOMの実際のスクロール位置で行う。
 */
export function LogsPanel({ jobId, status, workerKind, instanceId, ffmpegLogUrl }: Props) {
  const { token, onUnauthorized } = useAdminAuth();
  const [events, setEvents] = useState<AdminLogEvent[]>([]);
  const [logStreamFound, setLogStreamFound] = useState(true);
  const [consoleOutput, setConsoleOutput] = useState<string | null>(null);
  const [nextBackwardToken, setNextBackwardToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFfmpegNoise, setShowFfmpegNoise] = useState(false);
  /** 末尾追尾中か（表示用。フェッチの可否はDOMを直接見て判断する）。 */
  const [followingTail, setFollowingTail] = useState(true);

  const logRef = useRef<HTMLPreElement>(null);
  /** 自動更新のマージ元。setStateの更新関数の外でマージしたいので実体を持つ。 */
  const eventsRef = useRef<AdminLogEvent[]>([]);
  /** 次の描画後に末尾へスクロールする予約。 */
  const scrollToBottomRef = useRef(false);
  /** 自動更新の多重実行防止（前回のリクエストが遅れている間はスキップする）。 */
  const refreshingRef = useRef(false);

  /** `<pre>`が未描画（ログストリーム未検出など）の間は追尾中として扱う。 */
  const isTailVisible = (): boolean => {
    const el = logRef.current;
    if (el === null) {
      return true;
    }
    return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD_PX;
  };

  const applyLogs = (events_: AdminLogEvent[]) => {
    eventsRef.current = events_;
    setEvents(events_);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchAdminLogs(token, jobId, { instanceId })
      .then((res) => {
        if (cancelled) {
          return;
        }
        setLogStreamFound(res.logStreamFound);
        applyLogs(res.events);
        setNextBackwardToken(res.nextBackwardToken);
        setConsoleOutput(res.consoleOutput);
        setLoading(false);
        // 初回はログの末尾（＝最新の行）を見たいので、描画後に一番下まで送る。
        scrollToBottomRef.current = true;
        setFollowingTail(true);
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        if (err instanceof AdminUnauthorizedError) {
          onUnauthorized();
          return;
        }
        setError(toErrorMessage(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // onUnauthorizedはdepsに含めない(useAdminResource.tsと同じ方針)。
  }, [jobId, instanceId, token]);

  /**
   * 予約されていれば末尾までスクロールする。`<pre>`の描画より先に予約が立つ
   * （初回読み込み完了と同時）ことがあるため、要素が無ければ予約を残したまま
   * 次の描画を待つ。
   */
  useLayoutEffect(() => {
    if (!scrollToBottomRef.current) {
      return;
    }
    const el = logRef.current;
    if (el === null) {
      return;
    }
    scrollToBottomRef.current = false;
    el.scrollTop = el.scrollHeight;
  });

  // 実行中ジョブの自動更新（末尾を表示している間だけ）。
  useEffect(() => {
    if (isTerminalStatus(status) || loading) {
      return;
    }
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (refreshingRef.current || !isTailVisible()) {
        return;
      }
      refreshingRef.current = true;
      fetchAdminLogs(token, jobId, { instanceId })
        .then((res) => {
          if (cancelled) {
            return;
          }
          setLogStreamFound(res.logStreamFound);
          setConsoleOutput(res.consoleOutput);
          const { events: merged, replaced } = mergeTailEvents(eventsRef.current, res.events);
          applyLogs(merged);
          if (replaced) {
            // 履歴が途切れた（または初めてログが現れた）ので、「さらに古いログ」の
            // カーソルも新しいページのものへ差し替える。
            setNextBackwardToken(res.nextBackwardToken);
          }
          setError(null);
          scrollToBottomRef.current = true;
        })
        .catch((err) => {
          if (cancelled) {
            return;
          }
          if (err instanceof AdminUnauthorizedError) {
            onUnauthorized();
            return;
          }
          setError(toErrorMessage(err));
        })
        .finally(() => {
          refreshingRef.current = false;
        });
    }, REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // onUnauthorizedはdepsに含めない(useAdminResource.tsと同じ方針)。
  }, [jobId, instanceId, token, status, loading]);

  const loadOlder = () => {
    if (!nextBackwardToken || loadingMore) {
      return;
    }
    setLoadingMore(true);
    fetchAdminLogs(token, jobId, { cursor: nextBackwardToken, instanceId })
      .then((res) => {
        applyLogs([...res.events, ...eventsRef.current]);
        setNextBackwardToken(res.nextBackwardToken);
        setLoadingMore(false);
      })
      .catch((err) => {
        if (err instanceof AdminUnauthorizedError) {
          onUnauthorized();
          return;
        }
        setError(toErrorMessage(err));
        setLoadingMore(false);
      });
  };

  const visibleEvents = showFfmpegNoise ? events : events.filter((e) => !isFfmpegNoise(e.message));
  const hiddenNoiseCount = events.length - visibleEvents.length;
  const autoRefreshing = !isTerminalStatus(status);

  return (
    <section className={styles.section}>
      <h2 className={styles.heading}>ワーカーログ</h2>
      {loading && <p>読み込み中…</p>}
      {error && <p className={styles.error}>{error}</p>}
      {ffmpegLogUrl && (
        <p className={styles.note}>
          <a href={ffmpegLogUrl} download>
            720p変換のffmpeg生ログ(全行)をダウンロード
          </a>
          （S3に3日間だけ保存されます）
        </p>
      )}

      {!loading && autoRefreshing && (
        <p className={styles.note}>
          {followingTail
            ? `実行中のジョブのため、${REFRESH_INTERVAL_MS / 1000}秒ごとに最新のログを自動取得しています。`
            : "自動取得を停止しています（ログを末尾までスクロールすると再開します）。"}
        </p>
      )}

      {!loading && logStreamFound && (
        <>
          <p className={styles.note}>
            Step Functionsのリトライが発生した場合、複数回の試行のログが同一ストリームに混在します。
          </p>
          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={showFfmpegNoise}
              onChange={(e) => setShowFfmpegNoise(e.target.checked)}
            />
            720p変換中のffmpeg進捗ログを表示する
            {hiddenNoiseCount > 0 && !showFfmpegNoise && `（${hiddenNoiseCount}件非表示中）`}
          </label>
          {nextBackwardToken && (
            <button
              type="button"
              className={styles.loadMore}
              onClick={loadOlder}
              disabled={loadingMore}
            >
              {loadingMore ? "読み込み中…" : "さらに古いログを読み込む"}
            </button>
          )}
          <pre
            className={styles.log}
            ref={logRef}
            onScroll={() => setFollowingTail(isTailVisible())}
          >
            {visibleEvents.length === 0
              ? events.length === 0
                ? "(ログがありません)"
                : "(ffmpeg進捗ログのみです。表示するには上のチェックボックスをオンにしてください)"
              : visibleEvents
                  .map((e) => `[${formatTimestamp(e.timestamp)}] ${e.message}`)
                  .join("\n")}
          </pre>
        </>
      )}

      {!loading && !logStreamFound && (
        <>
          <p className={styles.note}>
            {workerKind === "home"
              ? // 自宅ワーカーはデーモンがコンテナの出力を読んでPutLogEventsする
                // （`home-worker/src/logShipper.ts`）ため、ストリームが無い＝
                // コンテナを起動できなかったか、デーモンごと落ちたことを意味する。
                "ログストリームが見つかりません。自宅ワーカーがコンテナを起動できなかったか(イメージのpull失敗等)、ログ転送前にデーモンが停止した可能性があります。自宅サーバー側のsystemdログ(journalctl -u sattori-home-worker)を確認してください。"
              : "ログストリームが見つかりません。コンテナが一度も起動できず、UserData(bootstrap)段階(ECRログイン・pull等)で失敗した可能性があります。"}
          </p>
          {consoleOutput ? (
            <>
              <p className={styles.note}>代わりにEC2インスタンスのコンソール出力を表示します。</p>
              <pre className={styles.log}>{consoleOutput}</pre>
            </>
          ) : (
            // 自宅ワーカーのジョブにはインスタンスが無く、コンソール出力の
            // フォールバック自体が存在しない（APIもinstanceId無しでは取りに行かない）。
            workerKind !== "home" && (
              <p>
                コンソール出力も取得できませんでした（インスタンスが既に終了している場合は取得できません）。
              </p>
            )
          )}
        </>
      )}
    </section>
  );
}
