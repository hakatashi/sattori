import { useEffect } from "react";
import { useLocale } from "../i18n/LocaleContext.ts";
import { toLocalizedPath } from "../i18n/paths.ts";

const SITE_ORIGIN = "https://sattori.hakatashi.com";
const SITE_NAME = "TouhouSattori";

// エントリHTML（index.html/en/index.html）の`<title>`と一致させる（トップページの既定値）。
const DEFAULT_TITLES = {
  ja: "TouhouSattori - 東方リプレイ自動録画サービス",
  en: "TouhouSattori - Automatic Touhou Replay Recording",
} as const;

function upsertLink(rel: string): HTMLLinkElement {
  let link = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!link) {
    link = document.createElement("link");
    link.rel = rel;
    document.head.appendChild(link);
  }
  return link;
}

interface PageMetaOptions {
  /** ページ固有のタイトル。省略時はトップページの既定タイトル（`DEFAULT_TITLES`）を使う。 */
  title?: string;
  /** ja基準のパス（例: `"/about"`）。`toLocalizedPath`で現在言語のパスへ変換してcanonical URLを組み立てる。 */
  path: string;
  /** trueなら`<meta name="robots" content="noindex">`を出す（ジョブページ等、jobId込みの秘密URL）。 */
  noindex?: boolean;
}

/**
 * SPAのクライアントサイドルーティングでは`document.title`やcanonical URLが自動更新
 * されないため、ページ遷移のたびに書き換える（Issue #214）。エントリHTML
 * （index.html/en/index.html）が静的に持つ`<link rel="canonical">`と同じ要素を
 * 上書きすることで、ページごとにタグが増殖しないようにする。
 */
export function usePageMeta({ title, path, noindex = false }: PageMetaOptions) {
  const lang = useLocale();

  useEffect(() => {
    document.title = title ? `${title} - ${SITE_NAME}` : DEFAULT_TITLES[lang];
    upsertLink("canonical").href = `${SITE_ORIGIN}${toLocalizedPath(path, lang)}`;

    const robotsMeta = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
    if (noindex) {
      const meta = robotsMeta ?? document.createElement("meta");
      meta.name = "robots";
      meta.content = "noindex";
      if (!robotsMeta) {
        document.head.appendChild(meta);
      }
    } else {
      robotsMeta?.remove();
    }
  }, [title, path, lang, noindex]);
}
