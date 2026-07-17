import { ReplayCorruptError } from "./errors.js";
import { parseTh06 } from "./games/th06.js";
import { parseTh07 } from "./games/th07.js";
import { parseTh08 } from "./games/th08.js";
import { parseTh09 } from "./games/th09.js";
import { parseTh095 } from "./games/th095.js";
import { parseTh125 } from "./games/th125.js";
import { parseTh128 } from "./games/th128.js";
import { parseTh143Family } from "./games/th143.js";
import { parseTh10 } from "./games/th10.js";
import { parseTh11 } from "./games/th11.js";
import { parseTh12 } from "./games/th12.js";
import { parseTh1314 } from "./games/th13-14.js";
import { parseTh15 } from "./games/th15.js";
import { parseTh16 } from "./games/th16.js";
import { parseTh17 } from "./games/th17.js";
import { parseTh18 } from "./games/th18.js";
import { parseTh20 } from "./games/th20.js";
import type { ParsedReplay, ReplayParseResult } from "./types.js";

export * from "./game-ids.js";
export * from "./types.js";
export { ReplayCorruptError } from "./errors.js";

type Decoder = (buffer: Uint8Array) => ParsedReplay;

function magicOf(buffer: Uint8Array): string {
  return Array.from(buffer.subarray(0, 4), (b) => String.fromCharCode(b)).join("");
}

const DECODERS: Record<string, Decoder> = {
  T6RP: parseTh06,
  T7RP: parseTh07,
  T8RP: parseTh08,
  T9RP: parseTh09,
  t95r: parseTh095,
  t125: parseTh125,
  "128r": parseTh128,
  t143: (buffer) => parseTh143Family(buffer, "th143"),
  t156: (buffer) => parseTh143Family(buffer, "th165"),
  t10r: parseTh10,
  t11r: parseTh11,
  t12r: parseTh12,
  t13r: parseTh1314,
  t15r: parseTh15,
  t16r: parseTh16,
  t17r: parseTh17,
  t18r: parseTh18,
  t20r: parseTh20,
};

export function parseReplay(data: Uint8Array): ReplayParseResult {
  if (data.length < 4) {
    return { ok: false, error: { code: "too_short", message: "file is shorter than the 4-byte magic header" } };
  }

  const magic = magicOf(data);
  const decode = DECODERS[magic];
  if (!decode) {
    return {
      ok: false,
      error: { code: "unknown_magic", message: `unrecognized replay magic: ${JSON.stringify(magic)}` },
    };
  }

  try {
    const replay = decode(data);
    return { ok: true, replay };
  } catch (error) {
    if (error instanceof ReplayCorruptError) {
      return { ok: false, error: { code: "corrupt", message: error.message } };
    }
    // 未知の例外も安全側に倒し、決して throw しない。
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { code: "corrupt", message: `unexpected error while parsing: ${message}` } };
  }
}
