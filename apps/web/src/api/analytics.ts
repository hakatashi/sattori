import type { AnalyticsEventInput, GameId, ReplayParseFailureCode } from "@sattori/shared";

/**
 * Cookie無しの計測ビーコン送信先（Issue #142）。`client.ts`の`API_BASE`（本番では
 * API GatewayのURLを直接指す）を経由せず、**常に現在ページと同一オリジンの相対パス**
 * を使う。CloudFront(WebCdn)の`/beacon`ビヘイビアがHTTP APIへ転送する際に
 * `CloudFront-Viewer-Country`ヘッダーを付与するため（`infra/lib/sattori-stack.ts`）、
 * API Gatewayを直接叩くと国情報が取れなくなる。
 */
const BEACON_PATH = "/beacon";

/** URL中のUUIDセグメント（`jobId`のような秘密値、Issue #4）を`:id`に丸める。 */
function normalizePath(pathname: string): string {
  return pathname.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    ":id",
  );
}

/**
 * ビーコンを送る。失敗してもユーザー体験に影響させないため、レスポンスは見ず
 * 例外も握り潰す。`navigator.sendBeacon`が使えない環境（テスト環境含む）では
 * `fetch`にフォールバックする。
 */
function send(payload: AnalyticsEventInput): void {
  try {
    const body = JSON.stringify(payload);
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      navigator.sendBeacon(BEACON_PATH, new Blob([body], { type: "application/json" }));
      return;
    }
    void fetch(BEACON_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    });
  } catch {
    // 計測の失敗はユーザー体験に影響させない。
  }
}

/** ページ閲覧イベントを送る。`pathname`はUUIDセグメントを`:id`に丸めてから渡す。 */
export function trackPageview(pathname: string): void {
  const params = new URLSearchParams(window.location.search);
  send({
    type: "pageview",
    path: normalizePath(pathname),
    referrer: document.referrer || null,
    utmSource: params.get("utm_source"),
    utmMedium: params.get("utm_medium"),
    utmCampaign: params.get("utm_campaign"),
    viewportWidth: window.innerWidth,
  });
}

/** リプレイのパース失敗イベントを送る（`parseReplayInfo()`が`ok: false`を返した時）。 */
export function trackParseError(errorCode: ReplayParseFailureCode, game: GameId | null): void {
  send({ type: "parse_error", errorCode, game });
}
