import { ReplayCorruptError } from "./errors.js";

/**
 * A low-level cursor for reading through .rpy binary data.
 * Out-of-range access does not throw a generic exception but a
 * ReplayCorruptError (caught at the parseReplay() boundary and
 * converted to a discriminated error value).
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

  /** Jumps to an absolute position. */
  seek(offset: number): void {
    if (offset < 0 || offset > this.bytes.length) {
      throw new ReplayCorruptError(`seek out of range: ${offset} (length ${this.bytes.length})`);
    }
    this.pos = offset;
  }

  /** Moves relative to the current position. */
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
   * Equivalent to ReadStringANSI in raviddog/threplay. Reads until a
   * CR(0x0D)+LF(0x0A) sequence is found as the string terminator, leaving the
   * cursor just before the terminator (right before the 0x0A), so that
   * subsequent fields' `skip()` offsets match the original implementation
   * (this behavior is faithfully reproduced byte-for-byte).
   *
   * Returns the raw byte sequence. Character encoding conversion is done by
   * the caller (decodeAnsiText).
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
    // Equivalent to `file.Seek(-1, SeekOrigin.Current)` in the original implementation.
    this.pos -= 1;
    return Uint8Array.from(out);
  }

  readAnsiString(): string {
    return decodeAnsiText(this.readAnsiBytes());
  }
}

/**
 * Decodes ANSI/Shift_JIS strings. The Japanese version of Touhou replays
 * often stores player names and dates as Shift_JIS byte sequences.
 * raviddog/threplay's ReadStringANSI has a known limitation of turning each
 * byte directly into a char (equivalent to Latin1), which mangles Japanese
 * text (see the ReadStringWide comment in that same implementation). Here we
 * try Shift_JIS first and only fall back to Latin1 if that fails.
 */
export function decodeAnsiText(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  try {
    const decoded = new TextDecoder("shift_jis", { fatal: true }).decode(bytes);
    return decoded;
  } catch {
    // If invalid as Shift_JIS, or the runtime lacks shift_jis support,
    // treat it as Latin1 (1 byte = 1 char), same fallback as the original implementation.
    return Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  }
}
