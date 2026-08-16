/**
 * User-Agent文字列を粗いブラウザ/OSカテゴリへ丸める（Issue #142）。バージョン・
 * ビルド情報まで保持するとフィンガープリンティングの温床になるため、意図的に
 * 家系（ブラウザエンジンの系統）とOSの大分類だけを残す。
 */

export interface UserAgentClassification {
  browserFamily: string | null;
  osFamily: string | null;
}

export function classifyUserAgent(userAgent: string | null): UserAgentClassification {
  if (!userAgent) {
    return { browserFamily: null, osFamily: null };
  }
  return {
    browserFamily: classifyBrowserFamily(userAgent),
    osFamily: classifyOsFamily(userAgent),
  };
}

/**
 * 判定順序が重要: Edge・Opera・Samsung InternetのUAはいずれも"Chrome"や"Safari"を
 * 含み、iOS版ChromeのUAは"CriOS"だが"Safari"も含むため、派生ブラウザから先に
 * チェックしないと誤判定する。
 */
function classifyBrowserFamily(ua: string): string {
  if (/Edg\//.test(ua)) return "edge";
  if (/OPR\//.test(ua)) return "opera";
  if (/SamsungBrowser\//.test(ua)) return "samsung_internet";
  if (/Firefox\//.test(ua)) return "firefox";
  if (/CriOS\//.test(ua) || /Chrome\//.test(ua)) return "chrome";
  if (/Safari\//.test(ua)) return "safari";
  return "other";
}

function classifyOsFamily(ua: string): string {
  if (/Windows/.test(ua)) return "windows";
  if (/Android/.test(ua)) return "android";
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  if (/Mac OS X/.test(ua)) return "macos";
  if (/Linux/.test(ua)) return "linux";
  return "other";
}
