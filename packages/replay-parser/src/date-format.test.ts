import { describe, expect, it } from "vitest";
import {
  DATE_TOKENS_FULL,
  DATE_TOKENS_MD,
  DATE_TOKENS_MDY,
  DATE_TOKENS_YMD,
  DATE_TOKENS_YMD_HM,
  parseDateComponents,
} from "./date-format.js";

describe("parseDateComponents", () => {
  it("returns null for null input", () => {
    expect(parseDateComponents(null, DATE_TOKENS_YMD_HM)).toBeNull();
  });

  it("parses th06's MM/DD/YY (no time)", () => {
    expect(parseDateComponents("05/26/11", DATE_TOKENS_MDY)).toEqual({
      fullYear: null,
      shortYear: 11,
      month: 5,
      date: 26,
      hours: null,
      minutes: null,
      seconds: null,
    });
  });

  it("parses th07's MM/DD (no year, no time)", () => {
    expect(parseDateComponents("01/18", DATE_TOKENS_MD)).toEqual({
      fullYear: null,
      shortYear: null,
      month: 1,
      date: 18,
      hours: null,
      minutes: null,
      seconds: null,
    });
  });

  it("parses th08's YYYY/MM/DD HH:mm:ss", () => {
    expect(parseDateComponents("2026/01/24 16:18:16", DATE_TOKENS_FULL)).toEqual({
      fullYear: 2026,
      shortYear: null,
      month: 1,
      date: 24,
      hours: 16,
      minutes: 18,
      seconds: 16,
    });
  });

  it("parses th09's YY/MM/DD (no time)", () => {
    expect(parseDateComponents("26/01/23", DATE_TOKENS_YMD)).toEqual({
      fullYear: null,
      shortYear: 26,
      month: 1,
      date: 23,
      hours: null,
      minutes: null,
      seconds: null,
    });
  });

  it("parses the th095/th10-th18/th20/th125/th128/th143 shared YY/MM/DD HH:mm format", () => {
    expect(parseDateComponents("25/11/09 17:41", DATE_TOKENS_YMD_HM)).toEqual({
      fullYear: null,
      shortYear: 25,
      month: 11,
      date: 9,
      hours: 17,
      minutes: 41,
      seconds: null,
    });
  });

  it("returns null when the number of numeric groups doesn't match the expected token count", () => {
    expect(parseDateComponents("05/26", DATE_TOKENS_MDY)).toBeNull();
    expect(parseDateComponents("05/26/11 12:00", DATE_TOKENS_MDY)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseDateComponents("", DATE_TOKENS_MD)).toBeNull();
  });
});
