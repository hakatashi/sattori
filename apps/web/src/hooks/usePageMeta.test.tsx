import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { LocaleContext } from "../i18n/LocaleContext.ts";
import { usePageMeta } from "./usePageMeta.ts";

interface TestPageProps {
  title?: string;
  path: string;
  noindex?: boolean;
}

function TestPage({ title, path, noindex }: TestPageProps) {
  usePageMeta({ title, path, noindex });
  return null;
}

function getCanonical(): string | null {
  return document.head.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null;
}

function getRobots(): string | null {
  return document.head.querySelector('meta[name="robots"]')?.getAttribute("content") ?? null;
}

describe("usePageMeta", () => {
  it("titleを指定するとサイト名付きでdocument.titleを設定する", () => {
    render(<TestPage title="利用規約" path="/terms" />);
    expect(document.title).toBe("利用規約 - TouhouSattori");
  });

  it("title省略時はトップページの既定タイトルを使う", () => {
    render(<TestPage path="/" />);
    expect(document.title).toBe("TouhouSattori - 東方リプレイ自動録画サービス");
  });

  it("ja基準のpathから自己参照canonicalを組み立てる", () => {
    render(<TestPage title="About" path="/about" />);
    expect(getCanonical()).toBe("https://sattori.hakatashi.com/about");
  });

  it("enロケールではcanonicalに/enプレフィックスを付ける", () => {
    render(
      <LocaleContext.Provider value="en">
        <TestPage title="About" path="/about" />
      </LocaleContext.Provider>,
    );
    expect(getCanonical()).toBe("https://sattori.hakatashi.com/en/about");
  });

  it("noindexを指定するとmeta robotsを追加し、falseに戻すと除去する", () => {
    const { rerender } = render(<TestPage title="Job" path="/jobs/xxx" noindex />);
    expect(getRobots()).toBe("noindex");

    rerender(<TestPage title="Job" path="/jobs/xxx" noindex={false} />);
    expect(getRobots()).toBeNull();
  });
});
