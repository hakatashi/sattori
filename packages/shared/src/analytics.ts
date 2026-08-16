import type { GameId } from "./games.js";
import type { ReplayParseFailureCode } from "./replay.js";

/**
 * Cookie無しのサーバーサイド計測（Issue #142）。フロントエンド（apps/web）と
 * バックエンド（apps/api）が共有する `POST /beacon` の契約。
 *
 * **生IP・生User-Agent・訪問者を横断して繋げる識別子は意図的に扱わない**
 * （Cookie/localStorageは使わない）。国・言語・ブラウザ/OS種別といった属性は
 * すべてサーバー側（`apps/api/src/analytics.ts`）で粗いカテゴリへ正規化してから
 * 保存する。設計の背景と採らなかった選択肢は
 * [`docs/decisions/0024-cookieless-analytics-beacon.md`](../../../docs/decisions/0024-cookieless-analytics-beacon.md)。
 */

/** ページ閲覧イベント。`react-router-dom`のルート変更ごとに送る。 */
export interface PageviewEventInput {
  type: "pageview";
  /**
   * 閲覧パス。`jobId`のようなURL中の秘密値（Issue #4）を含めないよう、UUID
   * セグメントは呼び出し側（`apps/web/src/api/analytics.ts`）が`:id`に正規化して
   * から渡すこと。
   */
  path: string;
  /**
   * `document.referrer`をそのまま渡す（未取得・同一オリジンなら空文字列/null）。
   * サーバー側でホスト名のみに丸めてから保存する（フルパス・クエリはPIIになりうるため）。
   */
  referrer: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  /** `window.innerWidth`。サーバー側でモバイル/タブレット/デスクトップへ丸める。 */
  viewportWidth: number;
}

/**
 * リプレイのパース失敗イベント（Issue #142）。`parseReplayInfo()`が
 * `{ ok: false }`を返した際にフロントエンドから送る。
 */
export interface ParseErrorEventInput {
  type: "parse_error";
  errorCode: ReplayParseFailureCode;
  /** `errorCode`が`unsupported_game`の場合のみ判明する検出タイトル。それ以外は null。 */
  game: GameId | null;
}

export type AnalyticsEventInput = PageviewEventInput | ParseErrorEventInput;

/** POST /beacon のレスポンス（bodyは空でよい）。 */
export type RecordAnalyticsEventResponse = Record<string, never>;
