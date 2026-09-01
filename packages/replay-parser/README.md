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

## CLI

The package bundles a zero-dependency CLI tool (`touhou-replay-parser` and its short alias `threp`).

```bash
# Run directly via npx
npx @sattori/touhou-replay-parser th7_01.rpy

# Or install globally
npm install -g @sattori/touhou-replay-parser
threp th7_01.rpy
```

### Options

- `<file...>`: One or more `.rpy` files to parse. Use `-` (or pipe into stdin) to read from standard input.
- `-j, --json`: Output result as JSON. When multiple files are parsed, defaults to NDJSON (newline-delimited JSON, one record per line). Single files output formatted (pretty) JSON.
- `-s, --splits`: Display per-stage split records (text mode only).
- `-h, --help`: Show help message.
- `-v, --version`: Show version number.

### Examples

```bash
# Human-readable summary
threp th7_01.rpy

# Detailed split records
threp -s th7_01.rpy

# Formatted JSON output
threp -j th7_01.rpy

# NDJSON output for multiple files
threp -j th7_*.rpy

# Read from stdin
cat th7_01.rpy | threp -j
```

## Supported titles

Titles are identified by the 4-byte magic at the start of the file. th13
(東方神霊廟, TD) and th14 (東方輝針城, DDC) share the same magic `t13r`, so
they are distinguished by a version byte in the header.

| Game ID | Title | Verification status |
| --- | --- | --- |
| `th06` | 東方紅魔郷 (EoSD) | Verified with checked-in replays + in-game screenshots in `test-fixtures/` |
| `th07` | 東方妖々夢 (PCB) | Same as above |
| `th08` | 東方永夜抄 (IN) | Same as above (includes Shift_JIS character names) |
| `th09` | 東方花映塚 (PoFV) | Verified with checked-in replays in `test-fixtures/` (covering Story/Extra/Match) + samples obtained from [Silent Selene](https://www.silentselene.net/) |
| `th095` | 東方文花帖 (StB) | Same as above |
| `th10` | 東方風神録 (MoF) | Verified with checked-in replays in `test-fixtures/` |
| `th11` | 東方地霊殿 (SA) | Verified with `test-fixtures/` + screenshots |
| `th12` | 東方星蓮船 (UFO) | Verified with checked-in replays in `test-fixtures/` (covering all six characters and Hard/Extra/Lunatic) + Silent Selene samples |
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
| `th20` | 東方錦上京 (FW) | Player name/date/difficulty/stage/score verified with `test-fixtures/` (full clears, a game over, Extra, spell practice and stage practice) + screenshots; `character` verified against 16/16 distinct shot values from Silent Selene samples; `splits`/`frameCount`/`recordedAt` reverse-engineered by this package and verified against 88 real replays plus recorded video (see below) |

th19 (東方獣王園, UDoALG) is excluded because the game itself has no
replay-saving feature.

### Notes on th20 (東方錦上京, FW)

threplay only supports up to th18; th20 is implemented based on this
package's own investigation. The USER section (player name, date, difficulty,
stage, score) has been confirmed to use the same layout as th10-th18.

`character`, however, is deliberately **not** read from that USER section's
"Chara" field, unlike every other title sharing `readModernUserdata` — real
replays were found where that field contains outright garbage (e.g. `"test"`,
or a difficulty/stage word like `"Hard"`, apparently belonging to a different
field), while the surrounding fields were consistently fine. Instead,
`character` is derived from the numeric `shot`/`stones` fields in the
decompressed per-stage-header body, the same approach
[n-rook/thscoreboard](https://github.com/n-rook/thscoreboard)'s own th20
parser uses (see "Related work" below) — this requires th20's own header size
before that decompression (48 bytes, wider than th10-th18's shared 36-byte
layout, matching thscoreboard's own separate th20 kaitai header definition).
An earlier version of this file used the wrong (36-byte) header size, which
made the length/decompressed-size fields read from the wrong offset and
consistently produced a garbage, constant-size decompression output — at the
time misdiagnosed as "th20 moved the per-stage breakdown data elsewhere"
rather than corrupt input from a wrong header size.

`splits`, `frameCount` and `recordedAt` are this package's own reverse
engineering of that decompressed body, done because no other project decodes
them: threplay stops at th18, thscoreboard's th20 kaitai struct
(`replays/kaitai_parsers/th20.py`) defines only the header and no per-stage
layout, and Silent Selene consequently still renders "Stage split information
is unavailable for this replay" for every th20 upload including the top-ranked
ones. The body turned out to be a `0x100`-byte header followed by one
`[0x2a0-byte fixed record][variable-length input log]` pair per stage, with the
record holding the snapshot taken at the *start* of that stage. Verified on 88
real replays / 420 stage records (walking the chain lands exactly on the end of
the decompressed body every time, and the input log length is redundantly
derivable from the frame count), and cross-checked against the recorded video
and on-screen HUD of Sattori's own production jobs. The full write-up —
including the offsets that are still unidentified — is in
[`docs/research/th20-replay-format.md`](../../docs/research/th20-replay-format.md)
([English](../../docs/research/th20-replay-format.en.md)); the offsets themselves
are documented on `TH20_STAGE_RECORD` in `src/games/th20.ts`.

Two th20-specific quirks are worth knowing when reading `splits`:

- `piv` holds 異変値, th20's replacement for the PIV of earlier titles, in
  units of 1/5000 — the in-game HUD shows this value divided by 5000 with two
  decimals, and it saturates at 1,000,000 (displayed as "200.00").
- `additional.stones` is the per-colour 石 (stone) level, as a
  `{ red, blue, yellow, green }` object rather than an array — the colour order
  was confirmed against the per-異変敵 levels shown on the in-game stage result
  screen. `additional.stonesTotal` is their sum.

One more thing to be aware of when reading a practice-mode th20 replay: the
game's own replay list can label the stage differently from what the replay
actually contains (`test-fixtures/th20/th20_07.rpy` is a Hard stage 6 practice
clear that the in-game list shows as "St5"). Both the USER section and the stage
record say stage 6 there, which is what matches the actual playback.

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

### Field reference

#### `ReplayParseResult`

The discriminated union returned by `parseReplay(data)`:

| Property | Type | Description |
| --- | --- | --- |
| `ok` | `boolean` | `true` if parsing succeeded; `false` if an error occurred. |
| `replay` | [`ParsedReplay`](#parsedreplay) | Present when `ok === true`. Parsed replay metadata. |
| `error` | [`ReplayParseError`](#replayparseerror) | Present when `ok === false`. Error details. |

#### `ParsedReplay`

The decoded replay metadata object (`result.replay`):

| Field | Type | Description |
| --- | --- | --- |
| `game` | `ReplayGameId` | Short game identifier (e.g. `"th06"`, `"th07"`, `"th10"`, `"th20"`). |
| `gameTitle` | `string` | Full official title with subtitle (e.g. `"東方紅魔郷 ～ the Embodiment of Scarlet Devil."`). |
| `formatVersion` | `number \| null` | Raw version/format byte from the header. Meaning varies by game (e.g. `5` for th07, `144` for th13; `null` for th06/th08). |
| `player` | `string \| null` | Player name string (decoded from Shift_JIS with trailing padding trimmed). |
| `date` | `string \| null` | Date/time string as recorded in the file (format varies by game, e.g. `"05/26/11"`, `"2026/01/24 16:18:16"`, `"25/11/09 17:41"`). |
| `parsedDate` | [`ParsedDate`](#parseddate) \| `null` | `date` broken down into individual numeric components, so callers don't need to know each title's format to interpret it. `null` iff `date` is `null`. See below. |
| `recordedAt` | `number \| null` | The same moment as `date`, as a raw Unix epoch (seconds, UTC) read from a second, independent timestamp field. Populated for th10-th18 and th20 (`null` otherwise). See below. |
| `character` | `string \| null` | Raw shot type or character string (e.g. `"ReimuA"`, `"ReimuRed"`, Japanese string `"博麗　霊夢"` for th08; `null` for th143/th165). |
| `characterNameJa` | `string \| null` | Japanese display name for `character` (e.g. `"霊符"`, `"霊夢"`, `"霊夢A"`, `"霊夢 赤1"`). See below. |
| `characterNameEn` | `string \| null` | English display name for `character` (e.g. `"Reimu A"`, `"Reimu"`, `"Reimu A (Yukari)"`, `"Reimu Red"`). See below. |
| `difficulty` | `string \| null` | Difficulty string (e.g. `"Easy"`, `"Normal"`, `"Hard"`, `"Lunatic"`, `"Extra"`; `null` for scene-based titles like th125/th143). |
| `stage` | `string \| null` | Highest reached stage or scene string (e.g. `"Stage 6"`, `"Stage All Clear"`, `"2-4"`, `"Day 8 Scene 3"`; `null` for th06/th07). |
| `score` | `number \| null` | Final total score. |
| `cleared` | `boolean \| null` | `true` if cleared (Player Wins), `false` if failed/game over, `null` if determinable clear status is unavailable (e.g. th06). |
| `splits` | [`ReplayStageSplit[]`](#replaystagesplit) | Per-stage/segment records (empty array if unavailable or unsupported). |
| `frameCount` | `number \| null` | Total in-game playback frames. Divide by 60 for duration in seconds. See below. |

#### `ReplayStageSplit`

Per-stage breakdown records in `ParsedReplay.splits`:

| Field | Type | Description |
| --- | --- | --- |
| `stage` | `number \| null` | Stage number (1-based index). Snapshot taken at the start of the stage. |
| `score` | `number \| null` | Accumulated score at the start of this stage/segment. |
| `power` | `string \| null` | Power value as string (format varies by game, e.g. `"0"`, `"128"`, `"1.00"`, `"4.00"`). |
| `piv` | `number \| null` | Point of Item Value (PIV) or game-specific score metric (`null` for th06). |
| `lives` | [`ReplayResourceCount`](#replayresourcecount) \| `null` | Lives count and fragment info. |
| `bombs` | [`ReplayResourceCount`](#replayresourcecount) \| `null` | Bombs count and fragment info (`null` for th11, where bombs are tied to power). |
| `graze` | `number \| null` | Graze count (`null` for th06). |
| `additional` | `Record<string, number \| string \| (number \| string)[]> \| null` | Game-specific extra metrics (e.g. `{ rank: 16 }` for th06, `{ pointItems: 24, cherryMax: 250180 }` for th07, `{ trance: 200, tranceMax: 600 }` for th13). |
| `frameCount` | `number \| null` | Number of in-game frames played during this stage/segment. |

#### `ParsedDate`

`date` broken down into individual numeric components (`ParsedReplay.parsedDate`). Every field is the value verbatim as recorded (no century inferred for `shortYear`, no timezone assumed) — a field is `null` only when that title's format genuinely does not record it (see the per-title table below):

| Field | Type | Description |
| --- | --- | --- |
| `fullYear` | `number \| null` | 4-digit year, e.g. `2026`. Only th08 records this. |
| `shortYear` | `number \| null` | 2-digit year as recorded verbatim, e.g. `26`. |
| `month` | `number \| null` | Month, 1-12. |
| `date` | `number \| null` | Day of month. |
| `hours` | `number \| null` | Hour, 0-23. |
| `minutes` | `number \| null` | Minute. |
| `seconds` | `number \| null` | Second. Only th08 records this. |

`date`'s format (and thus which `parsedDate` fields end up populated) differs by title, confirmed against [n-rook/thscoreboard](https://github.com/n-rook/thscoreboard)'s own `time.strptime` calls in `replays/replay_parsing.py`:

| Titles | `date` format | Example |
| --- | --- | --- |
| th06 | `MM/DD/YY` | `"05/26/11"` |
| th07 | `MM/DD` (no year — genuinely absent from the file) | `"01/18"` |
| th08 | `YYYY/MM/DD HH:mm:ss` | `"2026/01/24 16:18:16"` |
| th09 | `YY/MM/DD` (no time) | `"26/01/23"` |
| th095, th10-th18, th20, th125, th128, th143/th165 | `YY/MM/DD HH:mm` | `"25/11/09 17:41"` |

`parseDateComponents()` (`src/date-format.ts`) implements this generically from an ordered list of components rather than one parser per title — see that file for the full derivation.

#### `ReplayResourceCount`

Structured unit count for lives and bombs:

| Field | Type | Description |
| --- | --- | --- |
| `count` | `number` | Whole unit count (or percentage gauge for th128). |
| `pieces` | `number \| null` | Fragments collected toward the next unit (`null` if no fragment system or untracked). |
| `maxPieces` | `number \| null` | Required fragments per 1 unit denominator (e.g. `5` for th11 lives, `8` for th13 bombs, `100` for th128; `null` if no fragment system). |

#### `ReplayParseError`

Error object returned when parsing fails (`result.error`):

| Field | Type | Description |
| --- | --- | --- |
| `code` | `ReplayParseErrorCode` | Error classification (`"too_short"`, `"unknown_magic"`, or `"corrupt"`). |
| `message` | `string` | Human-readable explanation of why parsing failed. |

### `characterNameJa` / `characterNameEn`

`character` is otherwise used verbatim as it appears in the source data (a raw
shot-id string like `"ReimuA"` for most titles, or, for th08, a Japanese
display-name string read directly from the file). `characterNameJa` /
`characterNameEn` provide a localized display name for `character` (e.g.
`"ReimuA"` → `characterNameJa: "霊符"` / `characterNameEn: "Reimu A"` for th06),
looked up via `localizeCharacterName()` (`src/character-names.ts`). Both are
`null` when `character` is `null` or doesn't match any known raw form for that
game.

The lookup tables are sourced from
[n-rook/thscoreboard](https://github.com/n-rook/thscoreboard) (the software
behind [Silent Selene](https://www.silentselene.net/), see "Related work"
below) — specifically `GetShotName`/`GetCharacterName` in
`replays/game_ids.py` and its `ja`/`en_US` gettext catalogs — cross-checked
against real replays fetched from Silent Selene's API rather than taken on
faith (see `character-names.ts` for details, including th08's Japanese raw
strings and th17's inconsistent internal spacing, both confirmed genuine this
way rather than assumed).

`splits[].lives` / `splits[].bombs` are not strings but a structured
`ReplayResourceCount` type (`{ count, pieces, maxPieces }`). For games with a
fragment system (fragments toward the next unit), `pieces`/`maxPieces` are
populated; for games without one, they are `null` (th128 is the sole
exception, where `count` holds a percentage and `maxPieces` is always 100 —
see the comments in `src/games/th128.ts` for details). Likewise,
`splits[].additional` returns game-specific extra info (UFO color, trance,
season, spell cards, etc.) as an object with typed properties rather than
strings (e.g. `{ ufoColors: ["Red", "None", "None"] }`). Each value is a
`ReplayStageSplitExtra`: a number, a string, a list of either, or — when the
entries are a fixed set of *named* slots rather than an ordered list, as with
th20's `{ stones: { red, blue, yellow, green } }` — a flat record of numbers.

### `recordedAt`

For th10-th18, the decompressed body opens with a fixed-width SJIS `name`
field immediately followed by a raw Unix epoch timestamp — a *second*,
independent recording of the same moment `date` represents, sourced from a
different part of the file. `recordedAt` exposes it as a plain number
(seconds since epoch, UTC).

This was found by cross-referencing
[n-rook/thscoreboard](https://github.com/n-rook/thscoreboard)'s per-title
kaitai struct definitions (`replays/kaitai_parsers/th1{0..8}.py`, class
`Header`), which define this field explicitly and use it — not the
human-readable `date` string — as their own canonical timestamp source for
these titles. Compared to `date`, `recordedAt` always carries the full
4-digit year (`date` truncates to 2 digits for these titles) and
second-level precision (`date` only has minutes here) — but it is still
just a read of the recording PC's own system clock, so it carries the same
"only as correct as that clock/timezone" caveat `date` already has; it is
not an independently-verified truth source.

Cross-validated against real replays (checked-in `test-fixtures/` plus
fresh downloads via `.agents/skills/silent-selene/`) for th10, th11, th12,
th13, th14, th15, th16, th17, and th18: converting the raw value to JST
(UTC+9, ZUN's own locale) matched `date` down to the minute in all but 2 of
roughly 15 samples checked, where it differed by exactly 1 hour — consistent
with the recording PC's own clock/timezone being slightly off rather than a
decoding error (see the comments on `RECORDED_AT_OFFSET_12BYTE_NAME` in
`src/games/modern-body.ts` for the full offset derivation, including why
th17/th18 need a different offset than th10-th16).

th20 keeps the same "fixed-width `name` followed by a Unix epoch" shape but
lays the rest of its body header out differently, so the shared
`RECORDED_AT_OFFSET_*` constants do not apply to it; its own offset
(`RECORDED_AT_OFFSET` in `src/games/th20.ts`) was derived separately, and
cross-checked against `date` on 86 real replays — every difference came out
as a whole number of hours, distributed like real time zones (UTC+9 on 47,
UTC+8 on 22, UTC+7 on 4, and so on), which is what you would expect if the
field is a UTC epoch and `date` is local time.

`null` for every other title.

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
- **th09**: same reverse-engineering approach as th07/th08 (a fixed-size
  per-checkpoint header followed by one fixed-width record per frame), with
  its own independently derived constants (a 32-byte header, 2 bytes/frame).
  th09 stores the self player's stage-by-stage log and the opponent's as two
  separate concatenated blocks (`scoreOffsets[0..9]` and `[10..19]`), so the
  self player's last stage/match doesn't run to the end of the decompressed
  body — its true end is the first populated slot of `[10..19]`. Two more
  blocks (`[20..29]`, `[30..39]`) mirror the same checkpoint spacing but are
  not used for `frameCount`. Cross-validated against real in-game timer
  readouts for all 9 stages of a checked-in fixture (`th9_07.rpy`): the
  computed frame count consistently overshoots the timer-based lower bound by
  an amount that scales with how many retries that stage had, rather than
  being random noise — see the comments on `STAGE_CHECKPOINT_HEADER_SIZE` in
  `src/games/th09.ts`.
- **th20**: reverse-engineered by this package (no other project decodes it,
  see the th20 notes above). Each stage record carries an explicit frame
  count, and the input log that follows it is exactly
  `6 * frames + ceil(frames / 30)` bytes long — the two fields are redundant,
  which both confirms the frame count and gives the walk a structural stop
  condition. Cross-checked against the recorded video of Sattori's own
  production jobs: for a six-stage Lunatic clear, all six per-stage durations
  matched the video to within a few seconds.

`null` for every other supported title (th095, th125, th128, th143/th165) —
the per-frame input log location for those has not been reverse-engineered
yet.

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
- [n-rook/thscoreboard](https://github.com/n-rook/thscoreboard)
  (Python) — web application containing replay parsing implementations in its
  `project/thscoreboard/replays` directory.

## License

MIT (see [LICENSE](./LICENSE); also see the "Credits" section above for background)
