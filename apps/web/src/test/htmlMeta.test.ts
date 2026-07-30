import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `index.html`(ja) と `en/index.html`(en) は「言語依存のメタ情報だけが異なる同型のHTML」
 * である必要がある。クローラーはJSを実行しないためOGPは静的HTMLに焼くしかなく、
 * 片方にだけタグを足すと配布URLによってunfurl結果が食い違うので、ここで検出する。
 */
const SITE_ORIGIN = "https://sattori.hakatashi.com";

// テスト環境はjsdomで、グローバルの`URL`はNodeの`fileURLToPath`が受け付けないため、
// パス解決に`new URL(relative, import.meta.url)`は使えない。
const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function parse(relativePath: string): Document {
  const html = readFileSync(join(WEB_ROOT, relativePath), "utf-8");
  return new DOMParser().parseFromString(html, "text/html");
}

const ja = parse("index.html");
const en = parse("en/index.html");

/** `<meta>`のキー(name/property)集合。値は言語で変わるのでキーだけを比べる。 */
function metaKeys(doc: Document): string[] {
  return [...doc.querySelectorAll("meta")]
    .map((meta) => meta.getAttribute("property") ?? meta.getAttribute("name"))
    .filter((key): key is string => key !== null)
    .sort();
}

function metaContent(doc: Document, key: string): string | null {
  const meta = doc.querySelector(`meta[property="${key}"], meta[name="${key}"]`);
  return meta?.getAttribute("content") ?? null;
}

describe("エントリHTMLのメタ情報", () => {
  it("ja版とen版で同じ`<meta>`キーを持つ", () => {
    expect(metaKeys(en)).toEqual(metaKeys(ja));
  });

  it("OGPの必須タグが揃っている", () => {
    for (const doc of [ja, en]) {
      for (const key of ["og:type", "og:url", "og:title", "og:description", "og:image", "og:locale"]) {
        expect(metaContent(doc, key), key).toBeTruthy();
      }
      expect(metaContent(doc, "twitter:card")).toBe("summary_large_image");
    }
  });

  it("`<html lang>`・og:locale・og:urlが言語ごとに正しい", () => {
    expect(ja.documentElement.getAttribute("lang")).toBe("ja");
    expect(metaContent(ja, "og:locale")).toBe("ja_JP");
    expect(metaContent(ja, "og:url")).toBe(`${SITE_ORIGIN}/`);

    expect(en.documentElement.getAttribute("lang")).toBe("en");
    expect(metaContent(en, "og:locale")).toBe("en_US");
    expect(metaContent(en, "og:url")).toBe(`${SITE_ORIGIN}/en`);
  });

  it("titleとdescriptionが言語ごとに異なる", () => {
    expect(ja.title).not.toBe(en.title);
    expect(metaContent(ja, "description")).not.toBe(metaContent(en, "description"));
    // og:title/og:description は `<title>`/description と揃える。
    for (const doc of [ja, en]) {
      expect(metaContent(doc, "og:title")).toBe(doc.title);
      expect(metaContent(doc, "og:description")).toBe(metaContent(doc, "description"));
    }
  });

  it("og:imageは言語ごとに異なる絶対URLで、実体が`public/`に存在する", () => {
    // キャッチコピーを画像に焼いているため、OGP画像も言語ごとに別ファイル。
    const images = [ja, en].map((doc) => metaContent(doc, "og:image"));
    expect(new Set(images).size).toBe(2);
    for (const image of images) {
      expect(image).toMatch(new RegExp(`^${SITE_ORIGIN}/`));
      const fileName = (image ?? "").slice(`${SITE_ORIGIN}/`.length);
      expect(existsSync(join(WEB_ROOT, "public", fileName)), `${fileName} が public/ に無い`).toBe(
        true,
      );
    }
    // 宣言する寸法は両言語共通(1200x630)。
    for (const doc of [ja, en]) {
      expect(metaContent(doc, "og:image:width")).toBe("1200");
      expect(metaContent(doc, "og:image:height")).toBe("630");
    }
  });

  it("hreflangが両言語+x-defaultを相互に指している", () => {
    for (const doc of [ja, en]) {
      const alternates = Object.fromEntries(
        [...doc.querySelectorAll('link[rel="alternate"]')].map((link) => [
          link.getAttribute("hreflang"),
          link.getAttribute("href"),
        ]),
      );
      expect(alternates).toEqual({
        ja: `${SITE_ORIGIN}/`,
        en: `${SITE_ORIGIN}/en`,
        "x-default": `${SITE_ORIGIN}/`,
      });
    }
  });

  it("SPAエントリのスクリプトを読み込んでいる", () => {
    for (const doc of [ja, en]) {
      expect(doc.querySelector('script[src="/src/main.tsx"]')).not.toBeNull();
    }
  });
});
