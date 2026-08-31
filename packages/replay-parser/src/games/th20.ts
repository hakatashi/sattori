import { ByteReader } from "../byte-reader.js";
import { localizeCharacterName } from "../character-names.js";
import { readBufferedUint32LE } from "../lzss.js";
import { readModernUserdata } from "../userdata.js";
import { DATE_TOKENS_YMD_HM, parseDateComponents } from "../date-format.js";
import { normalizeText, type ParsedReplay } from "../types.js";
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
 * file did, see the comment on `parseTh20` below — makes `comp_size`/`size` be
 * read from inside that padding instead of their real location, corrupting the
 * XOR+LZSS pipeline; this was misdiagnosed at the time as "th20 moved the
 * per-stage breakdown data elsewhere" (the resulting garbage decompression
 * output happened to consistently land at a fixed small size, which looked
 * like a deliberate format change rather than corrupt input).
 */
const TH20_HEADER_SIZE = 48;

/**
 * Offsets within th20's decompressed body header, confirmed against
 * thscoreboard's `replays/kaitai_parsers/th20.py` (`Th20.Header`) and
 * cross-validated against real replays fetched from Silent Selene (see
 * `.agents/skills/silent-selene/`): decoding with `TH20_HEADER_SIZE` above
 * (instead of the previously-assumed 36) makes the body decompress to a
 * realistic multi-hundred-KB size (matching actual gameplay data) rather than
 * a constant 256 bytes, and the `shot`/`stones[0]` fields read below matched
 * Silent Selene's independently-sourced "Shot" field (e.g. "Marisa Red2") for
 * every sample checked.
 */
const SHOT_OFFSET = 0xd8;
const STONE0_OFFSET = 0xdc;

const SHOT_BASES = ["Reimu", "Marisa"];
/** See `_20SubshotToStone` in thscoreboard's `replays/replay_parsing.py`. */
const STONE_NAMES = ["Red", "Red2", "Blue", "Blue2", "Yellow", "Yellow2", "Green", "Green2"];

/**
 * t20r (東方錦上京, FW) decoder.
 *
 * threplay (raviddog/threplay, the upstream this package was ported from)
 * only covers up to th18; th20 is implemented based on this package's own
 * investigation. The USER section layout (player name, date, difficulty,
 * stage, score after JumpToUser(12)) has been confirmed to be identical to
 * th10-th18 by cross-checking real replays
 * (`touhou-recorder/games/th20/replay/*.rpy`) against screenshots.
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
 * The per-stage breakdown remains unimplemented: thscoreboard's own th20
 * kaitai struct (`th20.py`) only defines the header, not a per-stage `Stage`
 * layout, meaning that hasn't been reverse-engineered upstream either. So
 * `splits`/`frameCount` are still empty/null, same as before this fix.
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

  return {
    game: "th20",
    gameTitle: REPLAY_GAME_TITLES.th20,
    formatVersion: null,
    player: normalizeText(userdata.name),
    // th20's body header layout differs from th10-th18's (see
    // TH20_HEADER_SIZE/SHOT_OFFSET above), so RECORDED_AT_OFFSET_* does not
    // apply here; that title's equivalent field has not been located.
    recordedAt: null,
    date: normalizeText(userdata.date),
    parsedDate: parseDateComponents(normalizeText(userdata.date), DATE_TOKENS_YMD_HM),
    character,
    characterNameJa,
    characterNameEn,
    difficulty: normalizeText(userdata.difficulty),
    stage: normalizeText(userdata.stage),
    score: userdata.score,
    cleared: userdata.stage.includes("Clear"),
    splits: [],
    frameCount: null,
  };
}
