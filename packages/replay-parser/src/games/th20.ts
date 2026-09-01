import { ByteReader } from "../byte-reader.js";
import { localizeCharacterName } from "../character-names.js";
import { readBufferedUint32LE } from "../lzss.js";
import { readModernUserdata } from "../userdata.js";
import { DATE_TOKENS_YMD_HM, parseDateComponents } from "../date-format.js";
import { emptySplit, normalizeText, resourceCount, type ParsedReplay, type ReplayStageSplit } from "../types.js";
import { REPLAY_GAME_TITLES } from "../game-ids.js";
import { decodeModernBody } from "./modern-body.js";

/**
 * th20's `Main` header (preceding the XOR+LZSS-compressed body) has a wider
 * `unused_2` padding field than th10-th18's shared 36-byte layout (24 bytes
 * instead of 12, for 48 bytes total before `comp_size`/`size`/the compressed
 * body) — confirmed against
 * [n-rook/thscoreboard](https://github.com/n-rook/thscoreboard)'s
 * `replays/kaitai_parsers/th_modern_20_header.py` (`Main`), which defines th20's
 * header separately from the generic `th_modern.py` for exactly this reason.
 * Using the wrong (36-byte) header size here — what an earlier version of this
 * file did — makes `comp_size`/`size` be read from inside that padding instead
 * of their real location, corrupting the XOR+LZSS pipeline.
 */
const TH20_HEADER_SIZE = 48;

/**
 * Offsets within th20's decompressed body header. `SHOT_OFFSET`/`STONE0_OFFSET`
 * were confirmed against thscoreboard's `replays/kaitai_parsers/th20.py`
 * (`Th20.Header`); the rest were reverse-engineered by this package (Issue
 * #176) — see the comment on `TH20_STAGE_RECORD` below for how, and
 * `docs/research/th20-replay-format.md` for the full write-up.
 *
 * The body header is exactly `BODY_HEADER_SIZE` (0x100) bytes; the per-stage
 * records start immediately after it.
 */
/**
 * Unix epoch (seconds, UTC) of the recording, immediately after the 16-byte
 * fixed-width `name` field — the same shape th10-th18 use, which is why the
 * value cross-checks against the USER section's `date` as a whole number of
 * hours (i.e. a real time zone) on every replay tested. The field is 64-bit,
 * but only the low `u32` is read, for the same reason `modern-body.ts` does:
 * it only overflows past year ~2106.
 */
const RECORDED_AT_OFFSET = 0x10;
/** Number of per-stage records that follow the header. */
const STAGE_COUNT_OFFSET = 0xd4;
const SHOT_OFFSET = 0xd8;
const STONE0_OFFSET = 0xdc;
const BODY_HEADER_SIZE = 0x100;

const SHOT_BASES = ["Reimu", "Marisa"];
/** See `_20SubshotToStone` in thscoreboard's `replays/replay_parsing.py`. */
const STONE_NAMES = ["Red", "Red2", "Blue", "Blue2", "Yellow", "Yellow2", "Green", "Green2"];

/**
 * Layout of th20's fixed-size per-stage record, reverse-engineered for Issue
 * #176 (no prior project — threplay, thscoreboard/Silent Selene, thprac —
 * decodes th20 splits; Silent Selene still renders "Stage split information is
 * unavailable for this replay" for every th20 upload).
 *
 * The decompressed body is `[0x100-byte header][record][input log][record]
 * [input log]...`, one (record, input log) pair per stage, with the record
 * holding the snapshot taken **at the start** of that stage — the same
 * convention as th10-th18 (so `score` on the "Stage N" row is the score
 * carried in from the end of stage N-1). `SIZE` is fixed at 0x2a0 and the
 * following input log's length is `INPUT_SIZE`, which is what makes the chain
 * walkable.
 *
 * Verified on 90 real replays (61 sampled from Silent Selene across all
 * difficulties + Extra + stage practice, 25 from Sattori's own production jobs,
 * 4 checked-in fixtures): walking the chain lands *exactly* on the end of the
 * decompressed body in every case, and the record count always equals the
 * body header's `STAGE_COUNT_OFFSET` field. See `docs/research/th20-replay-format.md`.
 */
const TH20_STAGE_RECORD = {
  /** Fixed record size. The variable-length input log follows immediately after. */
  SIZE: 0x2a0,
  /** Stage number: 1-6 for the main game, 7 for Extra (stage practice records just that one stage). */
  STAGE: 0x00,
  /** RNG seed for the stage (not exposed; recorded here for future reference). */
  SEED: 0x04,
  /**
   * Number of gameplay frames in this stage. Cross-checked against the
   * recorded video of two production jobs (per-stage boundaries matched to
   * within ~1s at 60fps) and self-consistent with `INPUT_SIZE` below.
   */
  FRAME_COUNT: 0x08,
  /**
   * Byte length of the input log that follows this record. It is fully
   * determined by `FRAME_COUNT` as `6 * frames + ceil(frames / 30)` (6 bytes
   * of input state per frame plus a 1-byte marker per 30-frame block), which
   * holds for all 447 stage records checked and is what `isPlausibleRecord`
   * uses as a structural sanity check.
   */
  INPUT_SIZE: 0x0c,
  /** Score at the start of the stage, divided by 10, as a 64-bit value. */
  SCORE: 0x70,
  /** 霊力 (power) x100. Always 100 (1.00) at the start of stage 1, capped at 400 (4.00). */
  POWER: 0xa0,
  /** Graze count (cumulative over the run; always 0 on the stage 1 record). */
  GRAZE: 0xac,
  /**
   * 異変値, th20's replacement for the PIV of earlier titles, in units of
   * 1/5000 — the in-game HUD shows this value divided by 5000 with two
   * decimals, and it saturates at 1,000,000 (displayed as "200.00").
   * Confirmed by reading the HUD out of two recorded production jobs at the
   * exact stage-boundary frames (124,837 -> "24.96", 1,000,000 -> "200.00").
   */
  ANOMALY: 0xb4,
  /**
   * Per-colour 石 (stone) level, in the order given by `STONE_COLORS`. These
   * are the same four numbers the in-game stage result screen shows as each
   * 異変敵's level, which is how the colour order was pinned down.
   */
  STONES: 0xf4,
  /** Total stone level; always equals the sum of the four `STONES` entries. */
  STONES_TOTAL: 0x104,
  /** 残り人数 (lives). Maxes out at 7, which is the number of slots the HUD draws. */
  LIVES: 0x128,
  /** 残り人数 (かけら) — life fragments, 0-2 out of 3. */
  LIFE_PIECES: 0x130,
  /**
   * Cumulative miss (death) count; 0 on every stage 1 record. Not directly
   * counted frame-by-frame in a video, but it never decreases, and the stages
   * it jumps in are exactly the ones after which `POWER` has dropped below the
   * maximum — see `docs/research/th20-replay-format.md` §5.
   */
  MISSES: 0x134,
  /** スペルカード (bombs). Maxes out at 7, same as `LIVES`. */
  BOMBS: 0x13c,
  /** スペルカード (かけら) — bomb fragments, 0-2 out of 3. */
  BOMB_PIECES: 0x140,
} as const;

/** Both かけら gauges are shown as "n/3" in-game. */
const PIECE_DENOMINATOR = 3;
/**
 * The four 石 colours, in the order `TH20_STAGE_RECORD.STONES` stores them.
 * Confirmed by comparing those four values against the per-異変敵 levels the
 * in-game stage result screen prints.
 */
const STONE_COLORS = ["red", "blue", "yellow", "green"] as const;
/**
 * Upper bound on the stage record count, used to keep a corrupt
 * `STAGE_COUNT_OFFSET` from driving an unbounded loop. The main game has 6
 * stages and Extra is recorded as a single stage 7 record, so anything beyond
 * this is nonsense.
 */
const MAX_STAGE_RECORDS = 8;

function readUint64LE(buffer: Uint8Array, offset: number): number {
  // Safe as a JS number: the field holds score/10, so it would need a score
  // above 9e16 to lose precision (the world record is ~2e10).
  return readBufferedUint32LE(buffer, offset) + readBufferedUint32LE(buffer, offset + 4) * 0x1_0000_0000;
}

/**
 * Guards a single step of the record walk. Besides the obvious bounds check,
 * this re-derives the input log length from the frame count (see
 * `TH20_STAGE_RECORD.INPUT_SIZE`): the two fields are redundant in real
 * replays, so a mismatch means we are no longer looking at a stage record and
 * must stop rather than emit garbage splits.
 */
function isPlausibleRecord(body: Uint8Array, offset: number): boolean {
  if (offset < 0 || offset + TH20_STAGE_RECORD.SIZE > body.length) return false;
  const frames = readBufferedUint32LE(body, offset + TH20_STAGE_RECORD.FRAME_COUNT);
  const inputSize = readBufferedUint32LE(body, offset + TH20_STAGE_RECORD.INPUT_SIZE);
  if (inputSize !== frames * 6 + Math.ceil(frames / 30)) return false;
  return offset + TH20_STAGE_RECORD.SIZE + inputSize <= body.length;
}

function readStageRecords(body: Uint8Array): { splits: ReplayStageSplit[]; frameCount: number | null } {
  const stageCount = Math.min(readBufferedUint32LE(body, STAGE_COUNT_OFFSET), MAX_STAGE_RECORDS);
  const splits: ReplayStageSplit[] = [];
  let frameCount = 0;
  let offset = BODY_HEADER_SIZE;

  for (let i = 0; i < stageCount; i++) {
    if (!isPlausibleRecord(body, offset)) break;
    const field = (relative: number) => readBufferedUint32LE(body, offset + relative);

    const split = emptySplit();
    split.stage = field(TH20_STAGE_RECORD.STAGE);
    split.score = readUint64LE(body, offset + TH20_STAGE_RECORD.SCORE) * 10;
    split.power = (field(TH20_STAGE_RECORD.POWER) / 100).toFixed(2);
    split.piv = field(TH20_STAGE_RECORD.ANOMALY);
    split.graze = field(TH20_STAGE_RECORD.GRAZE);
    split.lives = resourceCount(field(TH20_STAGE_RECORD.LIVES), field(TH20_STAGE_RECORD.LIFE_PIECES), PIECE_DENOMINATOR);
    split.bombs = resourceCount(field(TH20_STAGE_RECORD.BOMBS), field(TH20_STAGE_RECORD.BOMB_PIECES), PIECE_DENOMINATOR);
    const stones: Record<string, number> = {};
    STONE_COLORS.forEach((color, index) => {
      stones[color] = field(TH20_STAGE_RECORD.STONES + index * 4);
    });
    split.additional = {
      stones,
      stonesTotal: field(TH20_STAGE_RECORD.STONES_TOTAL),
      misses: field(TH20_STAGE_RECORD.MISSES),
    };
    const stageFrameCount = field(TH20_STAGE_RECORD.FRAME_COUNT);
    split.frameCount = stageFrameCount;
    splits.push(split);
    frameCount += stageFrameCount;

    offset += TH20_STAGE_RECORD.SIZE + field(TH20_STAGE_RECORD.INPUT_SIZE);
  }

  return { splits, frameCount: splits.length > 0 ? frameCount : null };
}

/**
 * t20r (東方錦上京, FW) decoder.
 *
 * threplay (raviddog/threplay, the upstream this package was ported from)
 * only covers up to th18; th20 is implemented based on this package's own
 * investigation. The USER section layout (player name, date, difficulty,
 * stage, score after JumpToUser(12)) has been confirmed to be identical to
 * th10-th18 by cross-checking real replays against screenshots.
 *
 * `character`, however, is NOT read from that USER section's "Chara" field
 * (unlike every other title using `readModernUserdata`): cross-checking a
 * batch of real replays against Silent Selene showed that field is
 * unreliable in th20 — some real replays contain literal garbage there (e.g.
 * `"test"`, or difficulty/stage words like `"Hard"`, seemingly belonging to a
 * different field), while the surrounding fields (name/date/difficulty/stage/
 * score) were consistently fine. thscoreboard's own th20 parser
 * (`replays/replay_parsing.py`'s `_Parse20`) doesn't use this text field
 * either — it derives the shot purely from the numeric `shot`/`stones` fields
 * in the decompressed body, which this package now does too (see
 * `SHOT_OFFSET`/`STONE0_OFFSET` above).
 *
 * `splits`/`frameCount` come from this package's own reverse engineering of
 * th20's per-stage record (Issue #176, `docs/research/th20-replay-format.md`),
 * which no other project decodes.
 */
export function parseTh20(original: Uint8Array): ParsedReplay {
  const userdata = readModernUserdata(new ByteReader(original));

  const decodedata = decodeModernBody(
    original,
    { blockSize: 0x400, base: 0x5c, add: 0xe1 },
    { blockSize: 0x100, base: 0x7d, add: 0x3a },
    TH20_HEADER_SIZE,
  );
  const shotBase = SHOT_BASES[readBufferedUint32LE(decodedata, SHOT_OFFSET)] ?? null;
  const stoneName = STONE_NAMES[readBufferedUint32LE(decodedata, STONE0_OFFSET)] ?? null;
  const character = shotBase !== null && stoneName !== null ? `${shotBase}${stoneName}` : null;
  const { ja: characterNameJa, en: characterNameEn } = localizeCharacterName("th20", character);
  const { splits, frameCount } = readStageRecords(decodedata);

  return {
    game: "th20",
    gameTitle: REPLAY_GAME_TITLES.th20,
    formatVersion: null,
    player: normalizeText(userdata.name),
    // th20's body header layout differs from th10-th18's, so the shared
    // RECORDED_AT_OFFSET_* constants do not apply; this title keeps the same
    // "fixed-width name followed by a Unix epoch" shape, only with a 16-byte
    // name field (see `RECORDED_AT_OFFSET` above and
    // `docs/research/th20-replay-format.md` §3).
    recordedAt: readBufferedUint32LE(decodedata, RECORDED_AT_OFFSET),
    date: normalizeText(userdata.date),
    parsedDate: parseDateComponents(normalizeText(userdata.date), DATE_TOKENS_YMD_HM),
    character,
    characterNameJa,
    characterNameEn,
    difficulty: normalizeText(userdata.difficulty),
    stage: normalizeText(userdata.stage),
    score: userdata.score,
    cleared: userdata.stage.includes("Clear"),
    splits,
    frameCount,
  };
}
