import { ByteReader } from "../byte-reader.js";
import { ReplayCorruptError } from "../errors.js";
import { additiveKeyDecode, decompress, readBufferedUint32LE } from "../lzss.js";
import { jumpToUser } from "../userdata.js";
import { emptySplit, normalizeText, resourceCount, type ParsedReplay, type ReplayStageSplit } from "../types.js";
import { REPLAY_GAME_TITLES } from "../game-ids.js";

const CHARACTERS = [
  "Reimu",
  "Marisa",
  "Sakuya",
  "Youmu",
  "Reisen",
  "Cirno",
  "Lyrica",
  "Mystia",
  "Tewi",
  "Yuuka",
  "Aya",
  "Medicine",
  "Komachi",
  "Eiki",
  "Merlin",
  "Lunasa",
];

const HEADER_SIZE = 0xc0;

/**
 * T9RP (東方花映塚) デコーダ。threplay の Read_T9RP を移植。
 * 対戦(VS)専用タイトルのため、プレイヤーのキャラクターは
 * トップレベルの character ではなく各 split の additional に
 * "PlayerChar vs OpponentChar" として現れる（story モード時は
 * split から先頭キャラをトップレベル character にも複製する）。
 */
export function parseTh09(original: Uint8Array): ParsedReplay {
  const reader = new ByteReader(original);
  jumpToUser(reader, 12);

  reader.readUint32LE();
  reader.skip(17);
  const name = reader.readAnsiString();
  reader.skip(11);
  const date = reader.readAnsiString();
  reader.skip(8);
  const difficulty = reader.readAnsiString();
  reader.skip(8);
  const stage = reader.readAnsiString();

  if (original.length < HEADER_SIZE + 0x20 + 40 * 4) {
    throw new ReplayCorruptError("file too short for T9RP header");
  }
  const buffer = original.slice();
  const length = readBufferedUint32LE(buffer, 0x0c);
  additiveKeyDecode(buffer, 24, buffer[0x15]!, 7);
  const dlength = readBufferedUint32LE(buffer, 0x1c);

  const scoreOffsets: number[] = [];
  let maxStage = 0;
  for (let i = 0; i < 40; i++) {
    const offset = readBufferedUint32LE(buffer, 0x20 + 4 * i);
    scoreOffsets.push(offset);
    if (i < 10 && offset !== 0) maxStage = i;
  }

  const shifted = buffer.slice(HEADER_SIZE);
  const decodeData = decompress(shifted, length - HEADER_SIZE, dlength);

  const splits: ReplayStageSplit[] = [];
  let character: string | null = null;

  if (scoreOffsets[9] === 0) {
    // ストーリーモード: ステージごとに自キャラ・相手キャラが記録される。
    for (let i = 0; i <= maxStage; i++) {
      const raw = scoreOffsets[i];
      if (!raw) continue;
      const offset = raw - HEADER_SIZE;
      const offsetP2 = scoreOffsets[10 + i]! - HEADER_SIZE;
      const split = emptySplit();
      split.stage = i + 1;
      split.score = readBufferedUint32LE(decodeData, offset) * 10;
      split.lives = resourceCount(decodeData[offset + 0x8] ?? 0);
      const selfChar = CHARACTERS[decodeData[offset + 0x6]!] ?? "?";
      const opponentChar = CHARACTERS[decodeData[offsetP2 + 0x6]!] ?? "?";
      split.additional = { self: selfChar, opponent: opponentChar };
      if (i === 0) character = selfChar;
      splits.push(split);
    }
  } else {
    // VSモード: 1エントリのみ。
    const offset1 = scoreOffsets[9]! - HEADER_SIZE;
    const offset2 = scoreOffsets[19]! - HEADER_SIZE;
    const selfChar = CHARACTERS[decodeData[offset1 + 0x6]!] ?? "?";
    const opponentChar = CHARACTERS[decodeData[offset2 + 0x6]!] ?? "?";
    const split = emptySplit();
    split.additional = { self: selfChar, opponent: opponentChar };
    character = selfChar;
    splits.push(split);
  }

  return {
    game: "th09",
    gameTitle: REPLAY_GAME_TITLES.th09,
    formatVersion: null,
    player: normalizeText(name),
    date: normalizeText(date),
    character,
    difficulty: normalizeText(difficulty),
    stage: normalizeText(stage),
    score: null,
    cleared: null,
    splits,
  };
}
