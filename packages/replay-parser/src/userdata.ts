import { ByteReader } from "./byte-reader.js";
import { ReplayCorruptError } from "./errors.js";

const USER_MAGIC = [0x55, 0x53, 0x45, 0x52]; // "USER"

/**
 * Equivalent to JumpToUser in threplay. Reads the 4-byte offset value at
 * `pointerFieldOffset`, confirms a "USER" marker exists at that position, and
 * then advances the cursor just past it.
 */
export function jumpToUser(reader: ByteReader, pointerFieldOffset: number): void {
  reader.seek(pointerFieldOffset);
  const offset = reader.readUint32LE();
  reader.seek(offset);
  const magic = reader.readBytes(4);
  if (!USER_MAGIC.every((b, i) => magic[i] === b)) {
    throw new ReplayCorruptError(`USER section marker not found at offset ${offset}`);
  }
}

/** Equivalent to `long.TryParse(text + "0", ...)`. Restores the omitted trailing digit before converting to a number. */
export function parseScoreWithTrailingZero(text: string): number | null {
  return parseIntStrict(`${text}0`);
}

export function parseIntStrict(text: string): number | null {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

export interface CommonUserdataFields {
  name: string;
  date: string;
  character: string;
  difficulty: string;
  stage: string;
  score: number | null;
}

/**
 * The USER section layout shared by th10 (東方風神録, MoF) through
 * th18 (東方虹龍洞, UM) (ported from threplay's `Read_Userdata`).
 */
export function readModernUserdata(reader: ByteReader): CommonUserdataFields {
  jumpToUser(reader, 12);
  reader.readUint32LE(); // USER section length (unused)
  reader.skip(4);
  reader.readAnsiString(); // e.g. "東方○○ リプレイファイル情報" ("Touhou XX Replay File Info", SJIS)
  reader.readAnsiString(); // game version string (unused)
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
  return { name, date, character, difficulty, stage, score };
}
