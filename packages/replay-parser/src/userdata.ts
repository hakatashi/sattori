import { ByteReader } from "./byte-reader.js";
import { ReplayCorruptError } from "./errors.js";

const USER_MAGIC = [0x55, 0x53, 0x45, 0x52]; // "USER"

/**
 * threplay の JumpToUser 相当。`pointerFieldOffset` にある4バイトのオフセット値を
 * 読み、その位置に "USER" マーカーがあることを確認してからカーソルをその直後へ進める。
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

/** `long.TryParse(text + "0", ...)` 相当。末尾に省略された1桁を復元してから数値化する。 */
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
 * th10 (風神録) 〜 th18 (虹龍洞) で共通の USER セクションレイアウト
 * （threplay の `Read_Userdata` を移植）。
 */
export function readModernUserdata(reader: ByteReader): CommonUserdataFields {
  jumpToUser(reader, 12);
  reader.readUint32LE(); // USER セクション長（未使用）
  reader.skip(4);
  reader.readAnsiString(); // 例: "東方○○ リプレイファイル情報" (SJIS)
  reader.readAnsiString(); // ゲームバージョン文字列（未使用）
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
