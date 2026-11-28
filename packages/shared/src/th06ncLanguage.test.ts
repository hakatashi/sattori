import { describe, expect, it } from "vitest";
import {
  DEFAULT_TH06NC_LANGUAGE,
  isTh06ncLanguage,
  supportsTh06ncLanguage,
  TH06NC_LANGUAGE_LABELS,
  TH06NC_LANGUAGES,
  th06ncLanguageOf,
} from "./th06ncLanguage.js";

describe("th06ncLanguage", () => {
  it("全言語に表示名がある（公式の12言語）", () => {
    expect(TH06NC_LANGUAGES).toHaveLength(12);
    for (const language of TH06NC_LANGUAGES) {
      expect(TH06NC_LANGUAGE_LABELS[language]).toBeTruthy();
    }
  });

  it("isTh06ncLanguage は Steam の言語名だけを受け付ける", () => {
    expect(isTh06ncLanguage("english")).toBe(true);
    expect(isTh06ncLanguage("latam")).toBe(true);
    expect(isTh06ncLanguage("klingon")).toBe(false);
    expect(isTh06ncLanguage("")).toBe(false);
    expect(isTh06ncLanguage(undefined)).toBe(false);
    expect(isTh06ncLanguage(1)).toBe(false);
  });

  it("th06nc だけが言語を選べる", () => {
    expect(supportsTh06ncLanguage("th06nc")).toBe(true);
    expect(supportsTh06ncLanguage("th06c")).toBe(false);
    expect(supportsTh06ncLanguage("th06")).toBe(false);
    expect(supportsTh06ncLanguage(null)).toBe(false);
  });

  it("th06ncLanguageOf は欠損・不正値を日本語にする", () => {
    expect(th06ncLanguageOf({})).toBe(DEFAULT_TH06NC_LANGUAGE);
    expect(th06ncLanguageOf({ th06ncLanguage: "bogus" })).toBe("japanese");
    expect(th06ncLanguageOf({ th06ncLanguage: "german" })).toBe("german");
  });
});
