import type { ReplayGameId } from "./game-ids.js";

/**
 * A resource count made up of a "whole unit count" plus "fragments toward the
 * next unit," as used for lives, bombs, etc. `pieces`/`maxPieces` are null for
 * games without a fragment system, or when the data cannot be obtained for
 * that game.
 *
 * Exception: th128 (妖精大戦争, GFW) uses this field as a percentage gauge —
 * `count` holds the percentage (0-100+), `maxPieces` is always 100, and
 * `pieces` is always null (see the comments in that file).
 */
export interface ReplayResourceCount {
  /** The whole unit count (or a percentage, for th128 only). */
  count: number;
  /** Number of fragments collected toward the next unit. */
  pieces: number | null;
  /** The fragment maximum (denominator). Null if it cannot be determined. */
  maxPieces: number | null;
}

/**
 * A per-stage record. Games track different fields, so fields not tracked by
 * a given game are null.
 */
export interface ReplayStageSplit {
  /**
   * Stage number (null if it cannot be determined). Most games record this
   * as a snapshot taken "at the start of the stage," so fields like `score`
   * effectively reflect the value "at the end of the previous stage"
   * (this matches the value shown on the "Stage N" line of the original
   * game's replay selection screen).
   */
  stage: number | null;
  /** Score at the time of this snapshot. */
  score: number | null;
  /** Power (kept as a string since notation differs by game, e.g. "1.00", "128"). */
  power: string | null;
  /** Game-specific score metric such as PIV (Point of Item Value). */
  piv: number | null;
  /** Lives. */
  lives: ReplayResourceCount | null;
  /** Bomb count. */
  bombs: ReplayResourceCount | null;
  /** Graze count. */
  graze: number | null;
  /**
   * Game-specific extra info such as UFO color, trance, season, etc. Key
   * names and value shapes differ by game (see the comments in each game's
   * decoder implementation). Null for games without such data.
   */
  additional: Record<string, number | string | (number | string)[]> | null;
  /**
   * Number of in-game frames played during this stage/segment (i.e. from
   * this checkpoint up to the next one, or to the end of the replay for the
   * last split). See `ParsedReplay.frameCount` for the fixed-60fps
   * conversion to seconds and the games this is currently populated for.
   * Null for games where this package does not (yet) know how to locate the
   * per-frame input log.
   */
  frameCount: number | null;
}

/**
 * The full set of information extractable from a `.rpy` file. `ReplayInfo` in
 * `packages/shared` corresponds to a subset of this type (only the fields
 * needed for Sattori's recording metadata display).
 */
export interface ParsedReplay {
  game: ReplayGameId;
  gameTitle: string;
  /**
   * The raw format/version byte read from the header (its meaning and offset
   * differ by game). Can be used as a clue to identify replays recorded with
   * an incompatible version of the original game (used by Sattori for #16
   * detection). Null for games where this cannot be determined.
   */
  formatVersion: number | null;
  player: string | null;
  /** Recording date/time, kept verbatim as it appears in the source data (e.g. "25/12/31"). */
  date: string | null;
  character: string | null;
  difficulty: string | null;
  /** The reached/recorded stage or scene notation (e.g. "Stage 6", "Extra"). */
  stage: string | null;
  score: number | null;
  /**
   * True/false only when a full clear (equivalent to "Player Wins") could be
   * detected. Null for games/replay types with no way to determine this.
   */
  cleared: boolean | null;
  /** Per-stage records (empty array for games where this cannot be determined). */
  splits: ReplayStageSplit[];
  /**
   * Total number of in-game frames the replay plays back (all recorded
   * stages/segments summed). The main-series games run gameplay logic at a
   * fixed 60 frames/sec, so dividing by 60 gives the playback duration in
   * seconds. This is the number of frames the game itself will replay, and
   * does not include any recording-pipeline overhead (menu automation,
   * end-of-replay detection lag, etc.) on top of that.
   * Null for games/replay types where this package does not (yet) know how
   * to locate the per-frame input log.
   */
  frameCount: number | null;
}

export type ReplayParseErrorCode =
  /** The file is too short to even read the magic bytes. */
  | "too_short"
  /** The first 4 bytes don't match any known Touhou replay magic. */
  | "unknown_magic"
  /** The magic is known, but this package doesn't implement a decoder for it yet. */
  | "unsupported_game"
  /** The magic is a known format, but the data that follows is invalid and cannot be safely parsed further. */
  | "corrupt";

export interface ReplayParseError {
  code: ReplayParseErrorCode;
  message: string;
  /** The game ID identified from the magic, for unsupported_game / corrupt. */
  game?: ReplayGameId;
}

export type ReplayParseResult = { ok: true; replay: ParsedReplay } | { ok: false; error: ReplayParseError };

/** Strips padding whitespace from fixed-length fields. An empty string is treated as null. */
export function normalizeText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function emptySplit(): ReplayStageSplit {
  return {
    stage: null,
    score: null,
    power: null,
    piv: null,
    lives: null,
    bombs: null,
    graze: null,
    additional: null,
    frameCount: null,
  };
}

export function resourceCount(count: number, pieces: number | null = null, maxPieces: number | null = null): ReplayResourceCount {
  return { count, pieces, maxPieces };
}
