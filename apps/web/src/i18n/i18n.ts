import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES, type SupportedLanguage } from "@sattori/shared";
import ja from "./locales/ja/translation.json" with { type: "json" };
import en from "./locales/en/translation.json" with { type: "json" };

// 言語の定義（対応言語一覧・既定言語）は apps/api とも共有するため
// `@sattori/shared` を単一のソースとする（`RequestMagicLinkRequest.language`）。
export { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES, type SupportedLanguage };

/**
 * 言語はブラウザ検出ではなく常にURLパス（"/" = ja, "/en/..." = en）で決まる
 * （AppRoot側でルートに応じてchangeLanguageする）。マジックリンクメールのURLは
 * バックエンドで`/jobs/{jobId}`固定生成のため、既定言語(ja)は常にプレフィックス無しで
 * 到達できる必要がある（apps/api/src/ses.ts）。
 */
void i18n.use(initReactI18next).init({
  resources: {
    ja: { translation: ja },
    en: { translation: en },
  },
  lng: DEFAULT_LANGUAGE,
  fallbackLng: DEFAULT_LANGUAGE,
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
