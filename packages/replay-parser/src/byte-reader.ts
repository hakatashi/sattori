import { ReplayCorruptError } from "./errors.js";

/**
 * .rpy バイナリを読み進めるための低レベルカーソル。
 * 範囲外アクセスは例外を投げず ReplayCorruptError を throw する
 * （parseReplay() の境界で捕捉し、判別可能なエラー値に変換される）。
 */
export class ByteReader {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  pos = 0;

  constructor(data: Uint8Array) {
    this.bytes = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get length(): number {
    return this.bytes.length;
  }

  private ensure(n: number): void {
    if (this.pos < 0 || this.pos + n > this.bytes.length) {
      throw new ReplayCorruptError(
        `unexpected end of file at offset ${this.pos} (need ${n} more byte(s), have ${this.bytes.length})`,
      );
    }
  }

  readUint8(): number {
    this.ensure(1);
    const value = this.bytes[this.pos]!;
    this.pos += 1;
    return value;
  }

  readUint16LE(): number {
    this.ensure(2);
    const value = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return value;
  }

  readUint32LE(): number {
    this.ensure(4);
    const value = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return value;
  }

  readFloat32LE(): number {
    this.ensure(4);
    const value = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return value;
  }

  readBytes(n: number): Uint8Array {
    this.ensure(n);
    const value = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return value;
  }

  /** 絶対位置へジャンプする。 */
  seek(offset: number): void {
    if (offset < 0 || offset > this.bytes.length) {
      throw new ReplayCorruptError(`seek out of range: ${offset} (length ${this.bytes.length})`);
    }
    this.pos = offset;
  }

  /** 現在位置からの相対移動。 */
  skip(delta: number): void {
    this.seek(this.pos + delta);
  }

  slice(start: number, end: number): Uint8Array {
    if (start < 0 || end > this.bytes.length || start > end) {
      throw new ReplayCorruptError(`slice out of range: [${start}, ${end}) (length ${this.bytes.length})`);
    }
    return this.bytes.subarray(start, end);
  }

  remaining(): Uint8Array {
    return this.bytes.subarray(this.pos);
  }

  all(): Uint8Array {
    return this.bytes;
  }

  /**
   * raviddog/threplay の ReadStringANSI 相当。CR(0x0D)+LF(0x0A) の並びを
   * 文字列終端として読み取り、終端の直前（0x0Aの手前）にカーソルを残す
   * （後続フィールドの `skip()` オフセットが元実装と一致するよう、この
   * 挙動をバイト単位で忠実に再現している）。
   *
   * 生バイト列を返す。文字コード変換は呼び出し側（decodeAnsiText）で行う。
   */
  readAnsiBytes(): Uint8Array {
    const out: number[] = [];
    let b0 = this.readUint8();
    let b1 = this.readUint8();
    if (!(b0 === 13 && b1 === 10)) {
      let b2 = this.readUint8();
      do {
        out.push(b0);
        b0 = b1;
        b1 = b2;
        b2 = this.readUint8();
      } while (b0 !== 13 && b1 !== 10);
    }
    // 元実装の `file.Seek(-1, SeekOrigin.Current)` に相当。
    this.pos -= 1;
    return Uint8Array.from(out);
  }

  readAnsiString(): string {
    return decodeAnsiText(this.readAnsiBytes());
  }
}

/**
 * ANSI/Shift_JIS 文字列のデコード。東方のリプレイは日本語版でプレイヤー名や
 * 日付に Shift_JIS バイト列を格納することが多い。raviddog/threplay の
 * ReadStringANSI は各バイトをそのまま char 化する（Latin1相当）だけで日本語が
 * 文字化けする既知の制約があった（同実装内の ReadStringWide のコメント参照）。
 * ここでは Shift_JIS を優先的に試し、失敗した場合のみ Latin1 にフォールバックする。
 */
export function decodeAnsiText(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  try {
    const decoded = new TextDecoder("shift_jis", { fatal: true }).decode(bytes);
    return decoded;
  } catch {
    // Shift_JIS として不正、またはランタイムが shift_jis 未対応の場合は
    // 1バイト=1文字の Latin1 として扱う（元実装と同じフォールバック）。
    return Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  }
}
