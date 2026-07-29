import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `index.html`(ja) と `en/index.html`(en) は「言語依存のメタ情報だけが異なる同型のHTML」
 * である必要がある。クローラーはJSを実行しないためOGPは静的HTMLに焼くしかなく、
 * 片方にだけタグを足すと配布URLによってunfurl結果が食い違うので、ここで検出する。
 */
const SITE_ORIGIN = "https://sattori.hakatashi.com";

function parse(relativePath: string): Document {
  const html = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf-8");
  return new DOMParser().parseFromString(html, "text/html");
}

const ja = parse("../../index.html");
const en = parse("../../en/index.html");

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

  it("og:imageは絶対URLで、両言語で共通", () => {
    const image = metaContent(ja, "og:image");
    expect(image).toMatch(new RegExp(`^${SITE_ORIGIN}/`));
    expect(metaContent(en, "og:image")).toBe(image);
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
