/**
 * A structured breakdown of a `.rpy` file's raw `date` string, so callers
 * don't have to know each title's specific format (component order,
 * whether the year is 2-digit/4-digit/absent, whether time is present) to
 * make sense of it. Every field is the value verbatim as recorded (no
 * century inferred for `shortYear`, no timezone assumed) — a field is
 * `null` only when that title's format genuinely does not record it.
 *
 * Format assignments per title were confirmed against
 * [n-rook/thscoreboard](https://github.com/n-rook/thscoreboard)'s own
 * `time.strptime` calls in `replays/replay_parsing.py` (see
 * `packages/replay-parser/README.md`'s `date` field entry for the
 * per-title table).
 */
export interface ParsedDate {
  /** 4-digit year, e.g. `2026`. Only th08 records this. */
  fullYear: number | null;
  /** 2-digit year as recorded verbatim, e.g. `26` (no century inferred). */
  shortYear: number | null;
  /** Month, 1-12. */
  month: number | null;
  /** Day of month. */
  date: number | null;
  hours: number | null;
  minutes: number | null;
  seconds: number | null;
}

function emptyParsedDate(): ParsedDate {
  return {
    fullYear: null,
    shortYear: null,
    month: null,
    date: null,
    hours: null,
    minutes: null,
    seconds: null,
  };
}

type DateToken = "YYYY" | "YY" | "MM" | "DD" | "HH" | "mm" | "ss";

/** th06: `MM/DD/YY`, e.g. `"05/26/11"`. */
export const DATE_TOKENS_MDY: readonly DateToken[] = ["MM", "DD", "YY"];
/** th07: `MM/DD`, e.g. `"01/18"` — no year (genuinely absent from the file, not a parsing gap; see README). */
export const DATE_TOKENS_MD: readonly DateToken[] = ["MM", "DD"];
/** th08: `YYYY/MM/DD HH:mm:ss`, e.g. `"2026/01/24 16:18:16"`. */
export const DATE_TOKENS_FULL: readonly DateToken[] = ["YYYY", "MM", "DD", "HH", "mm", "ss"];
/** th09: `YY/MM/DD`, e.g. `"26/01/23"` — no time. */
export const DATE_TOKENS_YMD: readonly DateToken[] = ["YY", "MM", "DD"];
/**
 * th095, th10-th18, th20, th125, th128, th143/th165: `YY/MM/DD HH:mm`,
 * e.g. `"25/11/09 17:41"`. The format shared by most supported titles.
 */
export const DATE_TOKENS_YMD_HM: readonly DateToken[] = ["YY", "MM", "DD", "HH", "mm"];

/**
 * Parses a `date` string (already normalized/trimmed, or `null`) into a
 * `ParsedDate`, given the ordered list of components the title's format
 * uses (see the `DATE_TOKENS_*` constants above). Splits on runs of
 * non-digit characters (`/`, ` `, `:`), which is sufficient for every
 * format the titles this package supports actually use.
 *
 * Returns `null` if `raw` is `null`/empty, or if the number of numeric
 * groups found doesn't match `tokens.length` — an unexpected format this
 * package doesn't know how to interpret, rather than guessing at one.
 */
export function parseDateComponents(raw: string | null, tokens: readonly DateToken[]): ParsedDate | null {
  if (raw == null) return null;
  const parts = raw.split(/[^0-9]+/).filter((part) => part.length > 0);
  if (parts.length !== tokens.length) return null;

  const result = emptyParsedDate();
  for (const [i, token] of tokens.entries()) {
    const value = Number(parts[i]);
    if (!Number.isFinite(value)) return null;
    switch (token) {
      case "YYYY":
        result.fullYear = value;
        break;
      case "YY":
        result.shortYear = value;
        break;
      case "MM":
        result.month = value;
        break;
      case "DD":
        result.date = value;
        break;
      case "HH":
        result.hours = value;
        break;
      case "mm":
        result.minutes = value;
        break;
      case "ss":
        result.seconds = value;
        break;
    }
  }
  return result;
}
