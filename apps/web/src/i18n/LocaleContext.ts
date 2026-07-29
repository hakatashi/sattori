import { createContext, useContext } from "react";
import { DEFAULT_LANGUAGE, type SupportedLanguage } from "./i18n.ts";

export const LocaleContext = createContext<SupportedLanguage>(DEFAULT_LANGUAGE);

/** 現在表示中のページの言語（URLの"/en"プレフィックス有無で決まる）。 */
export function useLocale(): SupportedLanguage {
  return useContext(LocaleContext);
}
