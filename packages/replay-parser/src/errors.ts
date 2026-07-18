/**
 * An unrecoverable problem encountered while reading a replay (corrupted file,
 * invalid offset, etc.). Thrown only inside decoders and always caught at the
 * parseReplay() boundary, where it is converted to a ReplayParseError. This
 * exception never escapes to callers.
 */
export class ReplayCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayCorruptError";
  }
}
