# @sattori/touhou-replay-parser

A zero-dependency TypeScript library for decoding Touhou Project main-series
replay files (`.rpy`). Written for
[Sattori](https://github.com/hakatashi/sattori) (a Touhou replay recording web
service), but designed with no dependency on Sattori-specific types, so it can
be used standalone.

Based on a TypeScript port of `ReplayDecoder.cs` (the C# implementation) from
[raviddog/threplay](https://github.com/raviddog/threplay), with additions for
correct decoding of Shift_JIS player names, safe error handling for corrupted
files, and support for titles that threplay did not cover.

## Installation

```bash
npm install @sattori/touhou-replay-parser
```

Requires Node.js >= 14 (or a modern browser). Player names and dates are
decoded as Shift_JIS via the global `TextDecoder`, which needs a full-ICU
build — the default for official Node.js binaries since Node.js 13. On a
runtime without Shift_JIS support, decoding silently falls back to Latin1
(mojibake for Japanese text, not an error) rather than failing outright.

## Usage

```ts
import { parseReplay } from "@sattori/touhou-replay-parser";
import { readFile } from "node:fs/promises";

const data = new Uint8Array(await readFile("th7_01.rpy"));
const result = parseReplay(data);

if (result.ok) {
  const { game, player, character, difficulty, score, cleared, splits } = result.replay;
  console.log(`${game}: ${player} / ${character} / ${difficulty} / ${score}`);
} else {
  // parseReplay never throws. Invalid, unsupported, or corrupted files are
  // returned as a discriminated error code instead.
  console.error(result.error.code, result.error.message);
}
```

`parseReplay` never throws. Internally detected corruption is caught as a
`ReplayCorruptError` and converted to `{ ok: false, error: { code: "corrupt", ... } }`.

## Supported titles

Titles are identified by the 4-byte magic at the start of the file. th13
(東方神霊廟, TD) and th14 (東方輝針城, DDC) share the same magic `t13r`, so
they are distinguished by a version byte in the header.

| Game ID | Title | Verification status |
| --- | --- | --- |
| `th06` | 東方紅魔郷 (EoSD) | Verified with checked-in replays + in-game screenshots in `test-fixtures/` |
| `th07` | 東方妖々夢 (PCB) | Same as above |
| `th08` | 東方永夜抄 (IN) | Same as above (includes Shift_JIS character names) |
| `th09` | 東方花映塚 (PoFV) | Verified with real replays (samples obtained from [Silent Selene](https://www.silentselene.net/)) |
| `th095` | 東方文花帖 (StB) | Same as above |
| `th10` | 東方風神録 (MoF) | Verified with real replays + screenshots/samples |
| `th11` | 東方地霊殿 (SA) | Verified with `test-fixtures/` + screenshots |
| `th12` | 東方星蓮船 (UFO) | Verified with Silent Selene samples |
| `th125` | ダブルスポイラー (DS) | Verified with checked-in replays in `test-fixtures/` |
| `th128` | 妖精大戦争 (GFW) | Verified with Silent Selene samples |
| `th13` | 東方神霊廟 (TD) | Verified with `test-fixtures/` + screenshots |
| `th14` | 東方輝針城 (DDC) | Same as above |
| `th143` | 弾幕アマノジャク (ISC) | Verified with checked-in replays in `test-fixtures/` |
| `th15` | 東方紺珠伝 (LoLK) | Verified with `test-fixtures/` + screenshots |
| `th16` | 東方天空璋 (HSiFS) | Verified with Silent Selene samples |
| `th165` | 秘封ナイトメアダイアリー (VD) | **Unverified** (ported from threplay only; no test data obtained yet) |
| `th17` | 東方鬼形獣 (WBaWC) | Verified with Silent Selene samples |
| `th18` | 東方虹龍洞 (UM) | Same as above |
| `th20` | 東方錦上京 (FW) | Player name/date/character/difficulty/stage/score verified with `test-fixtures/` + screenshots.<br>**Per-stage breakdown (splits) is not supported** (see below) |

th19 (東方獣王園, UDoALG) is excluded because the game itself has no
replay-saving feature.

### Notes on th20 (東方錦上京, FW)

threplay only supports up to th18; th20 is implemented based on this
package's own investigation. The USER section (player name, date, character,
difficulty, stage, score) has been confirmed to use the same layout as
th10-th18, but the "per-stage breakdown via header XOR decoding + LZSS
decompression" present in th10-th18 appears, on the samples at hand, to
always decompress to a constant size regardless of progress — suggesting the
format has likely changed. Since this has not been analyzed, `splits` always
returns an empty array.

## Output data

`ParsedReplay` (`result.replay` when `result.ok === true`) carries richer
information than `ReplayInfo`, the type used by Sattori itself (player name,
date, character, difficulty, stage, score, clear status). In particular,
`splits` (a per-stage breakdown of score, power, lives, bombs, graze, etc.)
and `formatVersion` (the raw version/format byte embedded in the header,
whose meaning differs per game and which this package does not attempt to
interpret) are not part of `ReplayInfo`.

Conversion to `ReplayInfo` for Sattori itself is handled by `fromParsedReplay()`
in `packages/shared` (this package deliberately does not include that
conversion logic, so as to avoid depending on Sattori-specific types).

`splits[].lives` / `splits[].bombs` are not strings but a structured
`ReplayResourceCount` type (`{ count, pieces, maxPieces }`). For games with a
fragment system (fragments toward the next unit), `pieces`/`maxPieces` are
populated; for games without one, they are `null` (th128 is the sole
exception, where `count` holds a percentage and `maxPieces` is always 100 —
see the comments in `src/games/th128.ts` for details). Likewise,
`splits[].additional` returns game-specific extra info (UFO color, trance,
season, spell cards, etc.) as an object with typed properties rather than
strings (e.g. `{ ufoColors: ["Red", "None", "None"] }`).

### `frameCount`

`frameCount` is the total number of in-game frames the replay plays back.
The main-series games run gameplay logic at a fixed 60 frames/sec, so
`frameCount / 60` gives the playback duration in seconds — useful for
estimating recording time before actually running the replay. It does not
include any recording-pipeline overhead (menu automation, end-of-replay
detection lag, etc.) layered on top by a consumer such as Sattori's worker.

Currently populated for:

- **th06**: unlike th07/th08 (see below), th06's replay body is
  uncompressed and stores a *sparse input-change-event log* rather than one
  fixed-width record per frame: `ReplayDataInput { frameNum: i32; inputKey:
  u16; padding: u16 }` (8 bytes), one record only when the held key
  combination actually changes. `frameNum` resets to ~0 at the start of
  every stage and the log is terminated by a sentinel `frameNum` of
  `9999999`. This layout was confirmed exactly (not just empirically) via
  `GensokyoClub/th06`'s decompilation of the game (`src/ReplayData.hpp`):
  `ZUN_ASSERT_SIZE(StageReplayData, 0x69780)` matches this package's
  16-byte header + `53998 * 8`-byte input array exactly, and the header's
  known fields (score/power/lives/bombs/rank) line up with the same
  offsets this package already read before frameCount support was added.
  `frameCount` for each stage is the `frameNum` of the last real record
  before that stage's terminator. Cross-validated against two real
  recorded replays (not checked into this repo, see
  `src/games/th06.ts`): a single-stage clear and a 6-stage clear both
  landed within a few percent of their independently known recorded
  durations. See the comments on `STAGE_INPUT_LOG_HEADER_SIZE` in
  `src/games/th06.ts`.
- **th07**: derived by reverse-engineering the per-checkpoint input log
  layout (not documented by threplay/threp, which don't parse this data at
  all). Cross-validated against real recorded durations of a checked-in
  fixture (`touhou-recorder` PoC reports: `th7_07.rpy` recorded at ~840-852s
  end-to-end; the computed frame count lands within that range) — see the
  comments on `STAGE_CHECKPOINT_HEADER_SIZE` in `src/games/th07.ts`.
- **th08**: same reverse-engineering approach as th07 (a fixed-size
  per-checkpoint header followed by one fixed-width record per frame), but
  independently derived and with different constants (a 2-byte-per-frame
  record instead of th07's 4). The header layout was cross-referenced
  against `GensokyoClub/th08`'s decompilation of `StageReplayData`
  (`src/ReplayManager.hpp`), which also revealed that the field threplay
  (and this package, until now) labeled `Time` in `splits[].additional` is
  actually `pointItemExteds` (a point-item-extend counter) — renamed to
  `pointItemExtends` here accordingly. Cross-validated against real
  recorded durations of two replays not checked into this repo (see
  `src/games/th08.ts`): a single-segment Extra-stage clear and a short
  spell-practice replay both landed within a few percent of their
  independently known recorded durations. See the comments on
  `STAGE_CHECKPOINT_HEADER_SIZE` in `src/games/th08.ts`.
- **th10-th18** (all titles sharing the `decodeModernBody` pipeline: th10,
  th11, th12, th13, th14, th15, th16, th17, th18): each stage's decompressed
  header carries an explicit frame-count field, confirmed against
  `Fluorohydride/threp`'s own C++ implementation (which reads this field to
  reconstruct input logs for its own purposes) and independently against
  `yiyuezhuo/touhou-replay-decoder`.

`null` for every other supported title (th09, th095, th125, th128,
th143/th165, th20) — the per-frame input log location for those has not
been reverse-engineered yet.

`splits[].frameCount` breaks the same total down per stage/segment (frames
played from that checkpoint up to the next one, or to the end of the replay
for the last split) for the same set of titles; `ParsedReplay.frameCount`
is simply the sum of every `splits[].frameCount`. It is `null` per-split
wherever the top-level `frameCount` is also `null`.

## Credits

Most of the decoding logic was independently written from scratch in
TypeScript, based on `ReplayDecoder.cs` from
[raviddog/threplay](https://github.com/raviddog/threplay). The core LZSS
decompression and XOR block decoding algorithms originate from `common.cpp`
in [Fluorohydride/threp](https://github.com/Fluorohydride/threp), which that
repository references.

th06 and th08's `frameCount` support (see above) was additionally
cross-referenced against the reverse-engineered struct layouts in
[GensokyoClub/th06](https://github.com/GensokyoClub/th06) (CC0-1.0) and
[GensokyoClub/th08](https://github.com/GensokyoClub/th08) (MIT), two
community decompilation projects — used here only as factual confirmation
of byte offsets/struct sizes already derived independently, not as a source
of copied code.

Neither repository carries an explicit OSS license
(threplay's `LICENCES.txt` only lists licenses for third-party dependencies
such as UI components, not for `ReplayDecoder.cs` itself). This package is
published under the MIT license as an independent implementation built from
factual information (byte offsets, XOR keys, etc.), but please make your own
judgment call about usage with this background in mind.

## Related work

Other open-source projects for parsing or reverse-engineering Touhou replay
files:

- [raviddog/threplay](https://github.com/raviddog/threplay) (C#) — the base
  this package's decoding logic was ported from; see "Credits" above.
- [Fluorohydride/threp](https://github.com/Fluorohydride/threp) (C++) — source
  of the LZSS decompression / XOR block decoding algorithms; see "Credits"
  above.
- [GensokyoClub/th06](https://github.com/GensokyoClub/th06) and
  [GensokyoClub/th08](https://github.com/GensokyoClub/th08) — decompilation
  projects used to cross-reference struct layouts for th06/th08 `frameCount`
  support; see "Credits" above.
- [yiyuezhuo/touhou-replay-decoder](https://github.com/yiyuezhuo/touhou-replay-decoder) —
  used to independently cross-validate the th10-th18 frame-count field (see
  the "`frameCount`" section above).
- [hoangcaominh/thrpy-parser](https://github.com/hoangcaominh/thrpy-parser)
  (Python) — listed here as prior art; its code has not been consulted or
  referenced during the development of this package.

## License

MIT (see [LICENSE](./LICENSE); also see the "Credits" section above for background)
