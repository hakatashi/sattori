import { ByteReader } from "../byte-reader.js";
import { readModernUserdata } from "../userdata.js";
import { normalizeText, type ParsedReplay } from "../types.js";
import { REPLAY_GAME_TITLES } from "../game-ids.js";

/**
 * t20r (東方錦上京, FW) decoder.
 *
 * threplay (raviddog/threplay, the upstream this package was ported from)
 * only covers up to th18; th20 is implemented based on this package's own
 * investigation. The USER section layout (player name, date, character,
 * difficulty, stage, score after JumpToUser(12)) has been confirmed to be
 * identical to th10-th18 by cross-checking real replays
 * (`touhou-recorder/games/th20/replay/*.rpy`) against screenshots.
 *
 * On the other hand, the "per-stage breakdown via XOR decoding + LZSS
 * decompression using the length/dlength at header offset 0x1c/0x20" present
 * in th10-th18 does not appear to carry the same meaning in th20: across all
 * 3 samples on hand, the decompressed size stays constant (256 bytes)
 * regardless of progress (likely because a format change moved that data
 * elsewhere). Since the stage-breakdown structure has not been analyzed yet,
 * `splits` always returns an empty array (name/date/character/difficulty/stage/score
 * can still be obtained).
 */
export function parseTh20(original: Uint8Array): ParsedReplay {
  const userdata = readModernUserdata(new ByteReader(original));

  return {
    game: "th20",
    gameTitle: REPLAY_GAME_TITLES.th20,
    formatVersion: null,
    player: normalizeText(userdata.name),
    date: normalizeText(userdata.date),
    character: normalizeText(userdata.character),
    difficulty: normalizeText(userdata.difficulty),
    stage: normalizeText(userdata.stage),
    score: userdata.score,
    cleared: userdata.stage.includes("Clear"),
    splits: [],
    frameCount: null,
  };
}
