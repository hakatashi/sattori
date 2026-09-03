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
| `th08` | 東方永夜抄 (IN) | Same as above (includes Shift_JIS character names, and a spell practice replay) |
| `th09` | 東方花映塚 (PoFV) | Verified with checked-in replays in `test-fixtures/` (covering Story/Extra/Match) + samples obtained from [Silent Selene](https://www.silentselene.net/) |
| `th095` | 東方文花帖 (StB) | Same as above |
| `th10` | 東方風神録 (MoF) | Verified with checked-in replays in `test-fixtures/` |
| `th11` | 東方地霊殿 (SA) | Verified with `test-fixtures/` + screenshots |
| `th12` | 東方星蓮船 (UFO) | Verified with checked-in replays in `test-fixtures/` (covering all six characters and Hard/Extra/Lunatic) + Silent Selene samples |
| `th125` | ダブルスポイラー (DS) | Verified with checked-in replays in `test-fixtures/` |
| `th128` | 妖精大戦争 (GFW) | Verified with checked-in replays in `test-fixtures/` (covering Route A/B/C and Hard/Lunatic) + Silent Selene samples; see "Notes on th128" below for fields this package reverse-engineered itself |
| `th13` | 東方神霊廟 (TD) | Verified with `test-fixtures/` + screenshots |
| `th14` | 東方輝針城 (DDC) | Same as above |
| `th143` | 弾幕アマノジャク (ISC) | Verified with checked-in replays in `test-fixtures/` |
| `th15` | 東方紺珠伝 (LoLK) | Verified with `test-fixtures/` + screenshots |
| `th16` | 東方天空璋 (HSiFS) | Verified with Silent Selene samples |
| `th165` | 秘封ナイトメアダイアリー (VD) | **Unverified** (ported from threplay only; no test data obtained yet) |
| `th17` | 東方鬼形獣 (WBaWC) | Verified with Silent Selene samples |
| `th18` | 東方虹龍洞 (UM) | Same as above |
| `th20` | 東方錦上京 (FW) | Verified with checked-in replays in `test-fixtures/` (full clears, a game over, Extra, spell practice and stage practice) + screenshots + Silent Selene samples; see "Notes on th20" below for fields this package reverse-engineered itself |

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
decompressed body, the same approach
[n-rook/thscoreboard](https://github.com/n-rook/thscoreboard)'s own th20
parser uses (see "Related work" below). That decompression needs th20's own
header size (48 bytes, wider than th10-th18's shared 36-byte layout); see the
comment on `TH20_HEADER_SIZE` in `src/games/th20.ts` for what goes wrong with
the shared one.

`splits`, `frameCount` and `recordedAt` are this package's own reverse
engineering of that decompressed body, done because no other project decodes
them — thscoreboard's th20 kaitai struct defines only the header and no
per-stage layout, so Silent Selene still renders "Stage split information is
unavailable for this replay" for every th20 upload. The body is a `0x100`-byte
header followed by one `[0x2a0-byte fixed record][variable-length input log]`
pair per stage, the record being the snapshot taken at the *start* of that
stage. Verified on 88 real replays / 420 stage records and cross-checked
against the recorded video and on-screen HUD of Sattori's own production jobs;
the full write-up, including the offsets that are still unidentified, is in
[`docs/research/th20-replay-format.md`](../../docs/research/th20-replay-format.md)
([English](../../docs/research/th20-replay-format.en.md)), and the offsets
themselves are on `TH20_STAGE_RECORD` in `src/games/th20.ts`.

Two th20-specific quirks are worth knowing when reading `splits`:

- `piv` holds 異変値, th20's replacement for the PIV of earlier titles, in
  units of 1/5000 — the in-game HUD shows this value divided by 5000 with two
  decimals, and it saturates at 1,000,000 (displayed as "200.00").
- `additional.stones` is the per-colour 石 (stone) level, as a
  `{ red, blue, yellow, green }` object rather than an array — the colour order
  was confirmed against the per-異変敵 levels shown on the in-game stage result
  screen. `additional.stonesTotal` is their sum. **Don't confuse this with
  `loadout`** (below): `additional.stones` is per-stage progress gained
  *during* the run (one number per colour), while `loadout` is the fixed
  pre-run equipment *choice* (one named stone per slot) — same underlying
  game mechanic (石), two unrelated numbers.

`ParsedReplay.loadout` holds the 4-slot 石 equipment loadout chosen before the
run starts (メイン異変石/拡散石/集中石/支援石, in that order), each slot
resolved to one of the 9 named stones (or `null` for コモン魔石/unrecognized).
`character` is derived only from the `main` slot; the other three
(`diffusion`/`focus`/`support`) don't affect it but are otherwise-unused
gameplay information now exposed for the first time. Indices 0/2/5/7 are
cross-checked against real equipment screens; 1/3/4/6 follow the equipment
list's positional order but have no fixture confirming them yet (research doc
§3.1.1).

Two more things to be aware of when reading a practice-mode th20 replay:

- **Spell practice replays carry the card number, not the card name.** th08
  writes the whole card into its USER section (so `stage` comes out as
  `"カード名\tNo. 87 恋符「ノンディレクショナルレーザー」"`); th20 stores no card
  name anywhere in the file, and its USER section only names the stage the card
  belongs to. The body header does hold the card index, so `stage` gets the
  game's own Spell Practice number appended (`"Stage 6 (Spell Practice
  No. 100)"`) and `splits[0].additional` gains a `spellCardNumber`. Resolving
  that number to a name would need a lookup table this package does not have
  (research doc §5).
- **The game's own replay list can label the stage differently from what the
  replay contains.** `test-fixtures/th20/th20_07.rpy` is a Hard stage 6 practice
  clear the in-game list shows as "St5"; both the USER section and the stage
  record say stage 6, which is what the playback actually does.

### Notes on th128 (妖精大戦争 ～ 東方三月精, GFW)

`cleared`, `recordedAt`, and the per-split `stage`/`graze`/`frameCount` (and
the summed top-level `frameCount`) are this package's own reverse
engineering of the decompressed body, cross-checked against two independent
reverse-engineerings that agree exactly on field names/offsets —
[n-rook/thscoreboard](https://github.com/n-rook/thscoreboard)'s
`replays/kaitai_parsers/th128.py` and
[puresign-tokyo/l-uploader](https://github.com/puresign-tokyo/l-uploader)'s
[`th128.ksy`](https://github.com/puresign-tokyo/l-uploader/blob/main/backend/src/parsers/threp-ksy/th128.ksy)
(see "Related work" below) — though neither project actually reads these
fields into its own output, so their *meaning* is this package's own
verification, done against the 4 checked-in `test-fixtures/th128/*.rpy`
replays and real in-game observation of each (reached stage, clear/game over,
and the sequence of stages passed through).

- `cleared` is bit `0x10` of the header's `cleared` field (offset `0x68` in
  the decompressed body); the low bits otherwise just duplicate the last
  split's raw `stage` id, already exposed directly (see below). Confirmed
  against all 4 fixtures: `3`/`4`/`11` (ended in game over) vs. `19 = 3 |
  0x10` (the one fixture that reached "B1 All" and actually cleared).
- `splits[].stage` is the raw in-game stage id, read as-is like every other
  title's `stage` field (no string label resolution) — **not** a contiguous
  1/2/3 counter, because th128's routing (Route A/A2/B/B2/C/C2, branching
  after stage 1 and again after stage 2) means the id space isn't sequential
  across a whole run. E.g. a Route A run that branches to A2 after clearing
  stage 1 records ids `1` then `4`, not `1` then `2`; confirmed against real
  in-game stage names for all 4 fixtures. This package does not resolve
  these ids to route/stage name strings (unlike the header's own `stage`
  text field, `ParsedReplay.stage`, which is read verbatim from the USER
  section as with every other title).
- `splits[].frameCount` (and the summed top-level `frameCount`) is read
  directly from an explicit per-stage field in the body (no reverse-engineered
  walk needed, unlike th06-th09/th20's input-log-based `frameCount`).
- `splits[].graze` is weaker-confidence than the fields above: both external
  kaitai definitions name this field "graze" (offset agreement only — neither
  project actually reads it), and GFW does have a real grazing mechanic (each
  grazed bullet recovers 1% of the 氷力/ice-power gauge per wikiwiki.jp/thk's
  妖精大戦争/基本戦略, "カスリ：1.00%/1弾" — folded into that gauge rather than
  shown as its own HUD counter, unlike mainline titles). But unlike
  `stage`/`frameCount`/`cleared` above, the actual per-stage values have not
  been cross-checked against a real grazed-bullet count from recorded
  footage — only that they start at 0 and increase monotonically across the
  4 checked-in fixtures.
- `recordedAt` uses the same "12-byte SJIS name immediately followed by a raw
  Unix epoch timestamp" shape as th10-th18 (only the low 32 bits are read,
  same precedent as `RECORDED_AT_OFFSET_12BYTE_NAME` in
  `games/modern-body.ts`), cross-validated against `date` for all 4 fixtures
  (matches to the minute in JST).

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
| `recordedAt` | `number \| null` | The same moment as `date`, as a raw Unix epoch (seconds, UTC) read from a second, independent timestamp field. Populated for th10-th18, th20, and th128 (`null` otherwise). See below. |
| `character` | `string \| null` | Raw shot type or character string (e.g. `"ReimuA"`, `"ReimuRed"`, Japanese string `"博麗　霊夢"` for th08; `null` for th143/th165). |
| `characterNameJa` | `string \| null` | Japanese display name for `character` (e.g. `"霊符"`, `"霊夢"`, `"霊夢A"`, `"霊夢 赤1"`). See below. |
| `characterNameEn` | `string \| null` | English display name for `character` (e.g. `"Reimu A"`, `"Reimu"`, `"Reimu A (Yukari)"`, `"Reimu Red"`). See below. |
| `difficulty` | `string \| null` | Difficulty string (e.g. `"Easy"`, `"Normal"`, `"Hard"`, `"Lunatic"`, `"Extra"`; `null` for scene-based titles like th125/th143). |
| `stage` | `string \| null` | Highest reached stage or scene string (e.g. `"Stage 6"`, `"Stage All Clear"`, `"2-4"`, `"Day 8 Scene 3"`; `null` for th06/th07). |
| `score` | `number \| null` | Final total score. |
| `cleared` | `boolean \| null` | `true` if cleared (Player Wins), `false` if failed/game over, `null` if determinable clear status is unavailable (e.g. th06). |
| `loadout` | [`ReplayLoadoutSlot[]`](#replayloadoutslot) \| `null` | Pre-run equipment/loadout customization (e.g. th20's 4-slot 石 choice), as an ordered list of named slots. `null` for games with no such concept, or where this package does not yet know how to read it (currently populated only for th20). |
| `splits` | [`ReplayStageSplit[]`](#replaystagesplit) | Per-stage/segment records (empty array if unavailable or unsupported). |
| `frameCount` | `number \| null` | Total in-game playback frames. Divide by 60 for duration in seconds. See below. |

#### `ReplayLoadoutSlot`

A single named slot in `ParsedReplay.loadout`:

| Field | Type | Description |
| --- | --- | --- |
| `slot` | `string` | Stable per-title identifier for the slot (e.g. `"main"`, `"diffusion"`, `"focus"`, `"support"` for th20). |
| `index` | `number \| null` | Raw index/id as stored in the replay, if the game encodes the choice that way. |
| `name` | `string \| null` | Resolved display name for the equipped item (e.g. `"Yellow2"`), or `null` if unrecognized or nothing is equipped. |

This shape is deliberately title-agnostic rather than th20-specific: other
titles let the player customize their starting loadout before a run too
(弾幕アマノジャク's support cards, 東方虹龍洞's 換装 gadgets) and could
populate the same shape once their own equipment-select data is
reverse-engineered. A loadout slot is chosen once before the run and fixed
for its whole duration — this is what distinguishes it from per-stage state
that can change as the run progresses (e.g. th18's `splits[].additional.cards`),
which stays on `ReplayStageSplit` instead.

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
`ReplayStageSplitExtra`: a number, a string, a list of either, or a flat record
of numbers for named slots (th20's `{ stones: { red, blue, yellow, green } }`).

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
lays the rest of its body header out differently, so its offset was derived
separately (`RECORDED_AT_OFFSET` in `src/games/th20.ts`) and cross-checked
against `date` on 86 real replays: every difference came out as a whole number
of hours, distributed like real time zones.

th128 also keeps the "12-byte name followed by a Unix epoch" shape (see the
"Notes on th128" section above); cross-validated against `date` on the 4
checked-in fixtures, matching to the minute in JST every time.

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
- **th20**: reverse-engineered by this package (see the th20 notes above). Each
  stage record carries an explicit frame count, and the input log that follows
  it is exactly `6 * frames + ceil(frames / 30)` bytes long — redundant fields
  that both confirm the count and give the walk a stop condition. Cross-checked
  against the recorded video of Sattori's own production jobs.
- **th128**: reverse-engineered by this package (see the "Notes on th128"
  section above). Each stage record carries an explicit frame count, no
  input-log walk needed. Cross-validated against real in-game observation
  (reached stage, clear status) for all 4 checked-in fixtures.

`null` for every other supported title (th095, th125, th143/th165) — the
per-frame input log location for those has not been reverse-engineered yet.

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
- [puresign-tokyo/l-uploader](https://github.com/puresign-tokyo/l-uploader)
  (TypeScript) — a replay uploader web application whose backend includes
  Kaitai Struct definitions for several titles' replay bodies, independently
  reverse-engineered by [@iyuzzuko](https://x.com/iyuzzuko).

## License

MIT (see [LICENSE](./LICENSE); also see the "Credits" section above for background)
