import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SITE_ORIGIN = "https://sattori.hakatashi.com";
const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// App.tsxのja/enツリーに定義された静的ページ一覧と一致させること（ジョブページ
// `/jobs/:jobId`はjobIdが認可の秘密値のため対象外、robots.txt側でクロールを止めている）。
const STATIC_PAGE_PATHS = ["/", "/about", "/info", "/terms", "/changelog", "/replay-help"];

function toUrl(path: string, lang: "ja" | "en"): string {
  if (lang === "ja") {
    return `${SITE_ORIGIN}${path}`;
  }
  return path === "/" ? `${SITE_ORIGIN}/en` : `${SITE_ORIGIN}/en${path}`;
}

const xml = readFileSync(join(WEB_ROOT, "public/sitemap.xml"), "utf-8");
const doc = new DOMParser().parseFromString(xml, "application/xml");
const urls = [...doc.getElementsByTagName("url")];

describe("robots.txt", () => {
  const robotsTxt = readFileSync(join(WEB_ROOT, "public/robots.txt"), "utf-8");

  it("ジョブページ・管理画面・APIのクロールを止め、sitemapを案内する", () => {
    expect(robotsTxt).toContain("Disallow: /jobs/");
    expect(robotsTxt).toContain("Disallow: /en/jobs/");
    expect(robotsTxt).toContain("Disallow: /admin/");
    expect(robotsTxt).toContain("Disallow: /api/");
    expect(robotsTxt).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);
  });
});

describe("sitemap.xml", () => {
  it("パースエラーが無い", () => {
    expect(doc.getElementsByTagName("parsererror").length).toBe(0);
  });

  it("静的ページごとにja/en両方のURLを列挙している", () => {
    const locs = urls.map((url) => url.getElementsByTagName("loc")[0]?.textContent);
    for (const path of STATIC_PAGE_PATHS) {
      expect(locs, path).toContain(toUrl(path, "ja"));
      expect(locs, path).toContain(toUrl(path, "en"));
    }
    expect(locs.length).toBe(STATIC_PAGE_PATHS.length * 2);
  });

  it("jobId込みのジョブページを含まない", () => {
    const locs = urls.map((url) => url.getElementsByTagName("loc")[0]?.textContent ?? "");
    expect(locs.some((loc) => loc.includes("/jobs/"))).toBe(false);
  });

  it("各urlがja/en/x-defaultのhreflangを相互に持ち、x-defaultはjaと一致する", () => {
    for (const url of urls) {
      const alternates = Object.fromEntries(
        [...url.getElementsByTagName("xhtml:link")].map((link) => [
          link.getAttribute("hreflang"),
          link.getAttribute("href"),
        ]),
      );
      expect(Object.keys(alternates).sort()).toEqual(["en", "ja", "x-default"]);
      expect(alternates["x-default"]).toBe(alternates.ja);
    }
  });
});
