import { ByteReader } from "../byte-reader.js";
import { readBufferedUint32LE } from "../lzss.js";
import { jumpToUser, parseScoreWithTrailingZero } from "../userdata.js";
import { emptySplit, normalizeText, type ParsedReplay, type ReplayStageSplit } from "../types.js";
import { REPLAY_GAME_TITLES } from "../game-ids.js";
import { decodeModernBody } from "./modern-body.js";

/**
 * t13r マジックは th13 (神霊廟/TD) と th14 (輝針城/DDC) の両方で使われ、
 * USER セクション内のバージョンバイト（144ならTD、それ以外はDDC）で判別する
 * （threplay の Read_t13r を移植。判別ロジックはコード内コメントに準拠）。
 *
 * 注: threplay の Read_t13r は関数末尾で `return Read_Userdata(ref replay)` を
 * 呼び、TD/DDC 判別用に読み進めた分（4バイトの「which game」マーカー + 1バイトの
 * バージョン）を考慮しない共通レイアウトで USER セクションを再度読み直しており、
 * 結果として name/date/character 等が正しい位置からズレて上書きされる（upstream の
 * バグと判断）。本移植では、TD/DDC 判別ロジックを反映した最初の読み取り結果を
 * そのまま採用し、この二重読み込みは行わない。
 */
export function parseTh1314(original: Uint8Array): ParsedReplay {
  const reader = new ByteReader(original);
  jumpToUser(reader, 12);

  reader.readUint32LE();
  reader.skip(4);
  reader.skip(4); // which game
  const versionByte = reader.readUint8();
  const isTd = versionByte === 144;

  reader.readAnsiString();
  reader.readAnsiString();
  reader.skip(5);
  const name = reader.readAnsiString();
  reader.skip(5);
  const date = reader.readAnsiString();
  reader.skip(6);
  const character = reader.readAnsiString();
  reader.skip(5);
  const difficulty = reader.readAnsiString();
  const stage = reader.readAnsiString();
  reader.skip(6);
  const score = parseScoreWithTrailingZero(reader.readAnsiString());

  const splits: ReplayStageSplit[] = [];
  const decodedata = decodeModernBody(
    original,
    { blockSize: 0x400, base: 0x5c, add: 0xe1 },
    { blockSize: 0x100, base: 0x7d, add: 0x3a },
  );

  if (isTd) {
    let stageOffset = 0x74;
    const stageCount = Math.min(decodedata[0x58] ?? 0, 6);
    for (let i = 0; i < stageCount; i++) {
      const split = emptySplit();
      split.stage = decodedata[stageOffset] ?? null;
      split.score = readBufferedUint32LE(decodedata, stageOffset + 0x1c) * 10;
      split.power = (readBufferedUint32LE(decodedata, stageOffset + 0x44) / 100).toFixed(2);
      split.piv = Math.trunc(readBufferedUint32LE(decodedata, stageOffset + 0x38) / 1000) * 10;
      const lives = decodedata[stageOffset + 0x50] ?? 0;
      const livePieces = decodedata[stageOffset + 0x54] ?? 0;
      const bombs = decodedata[stageOffset + 0x5c] ?? 0;
      const bombPieces = decodedata[stageOffset + 0x60] ?? 0;
      const trance = decodedata[stageOffset + 0x64] ?? 0;
      split.additional = `Trance: ${trance}/600`;
      split.lives = `${lives} (${livePieces})`;
      split.graze = readBufferedUint32LE(decodedata, stageOffset + 0x2c);
      split.bombs = `${bombs} (${bombPieces}/8)`;
      splits.push(split);
      stageOffset += readBufferedUint32LE(decodedata, stageOffset + 0x8) + 0xc4;
    }
  } else {
    let stageOffset = 0x94;
    const stageCount = Math.min(decodedata[0x78] ?? 0, 6);
    for (let i = 0; i < stageCount; i++) {
      const split = emptySplit();
      split.stage = decodedata[stageOffset] ?? null;
      split.score = readBufferedUint32LE(decodedata, stageOffset + 0x1c) * 10;
      split.power = (readBufferedUint32LE(decodedata, stageOffset + 0x44) / 100).toFixed(2);
      split.piv = Math.trunc(readBufferedUint32LE(decodedata, stageOffset + 0x38) / 1000) * 10;
      const lives = decodedata[stageOffset + 0x50] ?? 0;
      const livePieces = decodedata[stageOffset + 0x54] ?? 0;
      const bombs = decodedata[stageOffset + 0x5c] ?? 0;
      const bombPieces = decodedata[stageOffset + 0x60] ?? 0;
      split.lives = `${lives} (${livePieces}/3)`;
      split.graze = readBufferedUint32LE(decodedata, stageOffset + 0x2c);
      split.bombs = `${bombs} (${bombPieces}/8)`;
      splits.push(split);
      stageOffset += readBufferedUint32LE(decodedata, stageOffset + 0x8) + 0xdc;
    }
  }

  const game = isTd ? "th13" : "th14";
  return {
    game,
    gameTitle: REPLAY_GAME_TITLES[game],
    formatVersion: versionByte,
    player: normalizeText(name),
    date: normalizeText(date),
    character: normalizeText(character),
    difficulty: normalizeText(difficulty),
    stage: normalizeText(stage),
    score,
    cleared: stage.includes("Clear"),
    splits,
  };
}
