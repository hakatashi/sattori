# Reverse-engineering the replay format of Touhou 6: Classic / New Classic

Investigated: 2026-09-10 / Subject: the two Embodiment of Scarlet Devil remakes
released 2026-09-10 / Implemented in:
`packages/replay-parser/src/games/th06.ts`
/ 日本語版: [`th06-classic-replay-format.md`](th06-classic-replay-format.md)

*This is an English translation of the Japanese document linked above. If the two
ever disagree, the Japanese one is authoritative.*

**Conclusion**: both titles are direct descendants of th06's (Touhou 6: Embodiment
of Scarlet Devil, 1.02h) replay format. They keep the `T6RP` magic, the +7
additive-key obfuscation, and the "fixed header → 7 per-stage snapshots →
sparse input-change-event log" structure unchanged. The only differences are
**wider fields from going 64-bit** (stage offsets and score become 8 bytes, input
records grow from 8 to 12 bytes) and **a 4-byte insertion for New Classic's added
game mode**. The metadata of all 13 replays checked against the real game (player
name, date, character, difficulty, mode, per-stage score) **matched on every
field**, so this was implemented in the parser as a confident result.

## Table of contents

- [1. What this investigates](#1-what-this-investigates)
- [2. Data used](#2-data-used)
- [3. The structure](#3-the-structure)
- [4. How this was pinned down](#4-how-this-was-pinned-down)
- [5. Verification](#5-verification)
- [6. Unknowns and data that would help](#6-unknowns-and-data-that-would-help)
- [7. Impact on Sattori](#7-impact-on-sattori)

## 1. What this investigates

"Touhou 6: Embodiment of Scarlet Devil - New Classic" and "Touhou 6: Embodiment of
Scarlet Devil - Classic" released on 2026-09-10. The former is an enhanced remaster
(4K support, refreshed graphics/music, adds a Challenge mode and spell practice);
the latter is close to a straight port of the original to a modern environment
(the in-game version string reads "ver. 1.03"). Both save replays to
`replay/th6_xx.rpy` under the game directory.

Since these released the same day, no public documentation of their internal
structure existed yet, and `@sattori/touhou-replay-parser` was feeding them through
the existing th06 decoder and **returning wrong values while reporting success**
(the magic is still `T6RP`, so it did not even come back as `unknown_magic`). This
investigation pinned down the format and made the parser recognize them as
separate titles (`th06c` / `th06nc`).

## 2. Data used

| Source | Files | Contents |
| --- | --- | --- |
| `packages/replay-parser/test-fixtures/th06c/` | 6 | Classic. All five difficulties (Easy/Normal/Hard/Lunatic/Extra), ReimuA/ReimuB/MarisaB, 2 full clears + 4 game overs |
| `packages/replay-parser/test-fixtures/th06nc/` | 7 | New Classic. All three modes (Standard/Challenge/SpellPractice), Easy/Hard/Lunatic/Extra, all 4 characters, 4 full clears + 3 game overs |
| `packages/replay-parser/test-fixtures/th06/` | 2 | Existing th06 (1.02h) fixtures, used as a comparison baseline |

For all 13 files, **the player name, recording date, character, game mode,
difficulty, lag rate, clear status, and per-stage score read off the in-game
replay-selection screen were available**, and were used as ground truth. Almost
every conclusion below comes from cross-checking against that ground truth.

## 3. The structure

### 3.1 Fixed header

The three variants, side by side. Offsets are post-decryption; everything from
right after `key` to the end is obfuscated with the +7 additive key
(`buffer[i] -= key; key += 7`, same as th06).

| Field | th06 (1.02h) | th06c (1.03) | th06nc |
| --- | --- | --- | --- |
| Magic `"T6RP"` | 0x00 (4) | 0x00 (4) | 0x00 (4) |
| Version `u16` | 0x04 = `0x0102` | 0x04 = `0x0103` | 0x04 = `0x010f` |
| Game mode `u8` | — | — | 0x06 |
| Character `u8` (0=ReimuA, 1=ReimuB, 2=MarisaA, 3=MarisaB) | 0x06 | 0x06 | 0x07 |
| Difficulty (0=Easy…4=Extra) | 0x07 `u8` | 0x07 `u8` | 0x08 `u32` |
| Checksum `u32` | 0x08 | 0x08 | 0x0c |
| Unknown `u16` | 0x0c | 0x0c | 0x10 |
| Additive key `u8` | 0x0e | 0x0e | 0x12 |
| Recording date `char[9]` (`MM/DD/YY` + NUL) | 0x10 | 0x10 | 0x14 |
| Player name `char[9]` | 0x19 | 0x19 | 0x1d |
| Score | 0x24 `u32` | 0x24 `u32` | 0x28 `u64` |
| `1.12 + lag rate` `f32` | 0x28 | 0x28 | 0x30 |
| **Lag rate (%)** `f32` | 0x2c | 0x2c | 0x34 |
| `2.34 + lag rate` `f32` | 0x30 | 0x30 | 0x38 |
| Unknown (always `0xffffffff`) | — | — | 0x3c |
| Stage offset array `[7]` | 0x34 `u32` | 0x38 `u64` (0x34 pads to the 8-byte boundary) | 0x40 `u64` |
| Stage data starts | 0x50 | 0x70 | 0x78 |

The stage offset array means the same thing it does in th06: indices 0-5 are
Stage 1-6, index 6 is Extra. Unused stages are 0.

New Classic's game mode (0x06) has these observed values:

| Value | Mode | Shown on the replay-selection screen |
| --- | --- | --- |
| 0 | Standard mode | `Standard` |
| 1 | Challenge mode | `Challenge` |
| 2 | **Unobserved** | — |
| 3 | Spell practice | `SpellPr` |

For a spell practice replay, the 4 bytes at 0x08 are not the difficulty but a
**zero-based spell card index** (a replay of "No.108 獄符「千本の針の山」" has
`107` = `0x6b` there). In this case, the difficulty appears nowhere in the file
(§6).

### 3.2 Checksum

th06's known formula — `0x3f000318` + the sum of every byte from 0x0e onward
(truncated to `u32`) — **carries over unchanged to Classic**. New Classic changes
both the seed and the start offset: it is `0x2f10a329` + the sum from 0x12
onward. Both matched exactly on 13/13 files.

```
th06   / th06c : checksum(0x08) == (0x3f000318 + Σ decoded[0x0e..]) & 0xffffffff
th06nc         : checksum(0x0c) == (0x2f10a329 + Σ decoded[0x12..]) & 0xffffffff
```

New Classic's seed `0x2f10a329` is not a round number, so the actual formula
(e.g. an earlier start offset with a constant mixed in partway through) may take
a different shape than this. This is only confirmed as an empirical constant
across 7 files. The parser does not verify the checksum.

### 3.3 Per-stage snapshot

A fixed-length header at the start of each stage offset. The field order is
unchanged from th06; going 64-bit widens the score to 8 bytes and shifts
everything after it.

| Field | th06 | th06c | th06nc |
| --- | --- | --- | --- |
| Score at stage start | +0x00 `u32` | +0x00 `u32` | +0x00 `u64` |
| Unknown (a cumulative value that grows with score) | +0x04 `u32` | +0x04 `u32` | +0x08 `u32` |
| Power `u8` | +0x08 | +0x08 | +0x0c |
| Lives `u8` | +0x09 | +0x09 | +0x0d |
| Bombs `u8` | +0x0a | +0x0a | +0x0e |
| Internal rank `u8` | +0x0b | +0x0b | **absent** (+0x0f is 0 on every file) |
| Total header size | 0x10 | 0x20 | 0x24 |

In New Classic, the byte corresponding to rank is 0 across every stage and every
file, and the 4 bytes at +0x10 take negative-looking values —
`0xffff4000` / `0xffff0204` — on stages 3 and 4 of th6_04, so it was judged to be
uninitialised garbage. `splits[].additional` is therefore `null` here (th06/th06c
keep returning `{ rank: N }` as before).

### 3.4 Input log

Right after the header comes a sparse log that writes one record **only when the
input state changes**. th06 used 8 bytes,
`{ frameNum: u32; inputKey: u16; padding: u16 }`, but both remakes expand this to
12 bytes and, further, **move `frameNum` from the front of the record to the
back**:

```c
// th06c / th06nc
struct ReplayDataInput {
    uint32_t inputKey;          // input state from this frame onward
    uint32_t previousInputKey;  // matches the previous record's inputKey
    uint32_t frameNum;          // frame count since the stage started
};
```

The terminator is the same sentinel record th06 uses (`frameNum == 9999999`). 8
bytes of zero padding follow the sentinel before the next stage's offset. Classic
writes the sentinel twice on the final stage only —
`(..., N), (0,0,9999999), (0,0,N), (0,0,9999999)` — which is the same behaviour
th06 has. New Classic does not double it.

## 4. How this was pinned down

Written in the order things were figured out. Classic comes first, New Classic
after.

1. **Decryption was assumed unchanged, and that held.** Classic decrypted cleanly
   with th06's own scheme — key = `buffer[0x0e]`, +7 additive starting at 0x0f —
   yielding readable `09/10/26` and `koyi`. The `u32` at 0x24 also matched the
   true score.
2. **Only the stage offset array failed to read.** From 0x34 onward the bytes
   looked like `00000000 70000000 00000000 b42f0000 …` — **a zero every 4
   bytes** — which suggested 64-bit fields. Re-reading in 8-byte strides starting
   at 0x38 restored th06's familiar semantics: only index 6 is filled for an
   Extra replay (th6_04), only index 0 is filled for a replay that died on stage
   1. The leading value `0x70` being exactly the header length also matches th06
   (where it is `0x50`).
3. **The input log's record size was pinned down using the sentinel and
   monotonicity.** Since a `0x0098967f` (= 9999999) sits right before each stage
   boundary, that was treated as the terminator, and every combination of record
   length and header length was brute-forced against the constraint that "some
   one `u32` field in the record is monotonically non-decreasing." Only
   12-byte records with a 0x20 header satisfied this on every stage.
4. **Field meaning was confirmed by an invariant.** Of the three `u32`s that
   survived step 3, the second always matched "the previous record's first
   field" — verified with zero violations across all 1005 records of stage 1
   (1003 pairs, excluding the head and the sentinel) — giving
   `{ inputKey, previousInputKey, frameNum }`. A mere phase shift (a 0x14 header
   also satisfies "multiple of 12") is ruled out by this invariant.
5. **New Classic started from locating the key.** Since the plaintext date string
   `09/10/26` had to appear somewhere, the relation "difference between adjacent
   decoded bytes = difference between adjacent ciphertext bytes − 7" narrowed
   down the position: key = `buffer[0x12]`, decryption starting at 0x13, date at
   0x14 — **a layout shifted +4 bytes relative to th06c throughout**.
6. **The +4 shift turned out to be two new header fields at the front.** 0x06/
   0x07 held `(0,0) (0,0) (3,1) (1,2) (0,3) (0,0) (0,0)`, and the `u32` at 0x08
   held `2, 4, 107, 2, 2, 3, 0`. Cross-referencing against the true "character" /
   "mode" / "difficulty" fully explained these as 0x06 = mode, 0x07 = character,
   0x08 = difficulty (or, for spell practice only, the spell index).
7. **The score becoming `u64` was confirmed at 0x28.** Skipping the `u16` at
   0x26, `60 65 76 05 00 00 00 00` = 91,645,280 matched the true total score.
8. **Whether the stage header was 0x18 or 0x24 bytes was ambiguous at first.**
   Assuming 0x18 produced many stages where the first record came out as
   `(0,0,K)` and the next record's `previousInputKey` contradicted it, whereas
   0x24 satisfied the invariant on every stage of every file (the only two
   exceptions were single mid-stage records, presumably a resync after taking a
   hit) — so 0x24 was chosen.
9. **The lag rate's position was corroborated by a three-way relation.** The
   three `f32`s at 0x30/0x34/0x38 always satisfy `a = 1.12 + s`, `s`,
   `b = 2.34 + s`, where the middle value matches the true lag rate. th06/th06c
   satisfy the same relation (at offsets 0x28/0x2c/0x30), which also corroborates
   the structural correspondence between the variants.

## 5. Verification

`parseReplay()`'s output cross-checked against ground truth read off the
in-game replay-selection screen. **All 13/13 files matched on every field**
(pinned as golden tests under `test-fixtures/`).

| File | Character | Difficulty/Mode | Score | Per-stage score | Total frames |
| --- | --- | --- | --- | --- | --- |
| th06c/th6_01 | ReimuA | Hard | 114,250,700 | all 6 stages match | 93,403 (25m 56s) |
| th06c/th6_02 | ReimuA | Easy | 1,407,360 | match | 4,589 (1m 16s) |
| th06c/th6_03 | ReimuB | Lunatic | 247,920 | match | 1,660 (27s) |
| th06c/th6_04 | ReimuA | Extra | 84,613,650 | match | 36,849 (10m 14s) |
| th06c/th6_05 | ReimuA | Normal | 1,126,970 | match | 3,847 (1m 04s) |
| th06c/th6_06 | MarisaB | Hard | 1,332,850 | match | 2,426 (40s) |
| th06nc/th6_01 | ReimuA | Hard / Standard | 91,645,280 | all 6 stages match | 105,355 (29m 15s) |
| th06nc/th6_02 | ReimuA | Extra / Standard | 68,468,720 | match | 45,388 (12m 36s) |
| th06nc/th6_03 | ReimuB | (difficulty unknown) / SpellPr No.108 | 5,710,640 | match | 1,063 (17s) |
| th06nc/th6_04 | MarisaA | Hard / Challenge | 103,229,340 | all 6 stages match | 87,443 (24m 17s) |
| th06nc/th6_05 | MarisaB | Hard / Standard | 22,647,970 | 3 stages' worth match | 22,381 (6m 13s) |
| th06nc/th6_06 | ReimuA | Lunatic / Standard | 44,139,720 | 3 stages' worth match | 37,022 (10m 17s) |
| th06nc/th6_07 | ReimuA | Easy / Standard | 514,850 | match | 1,265 (21s) |

There is no independent ground truth for `frameCount`, so it could not be
strictly verified, but plausibility was confirmed three ways:

- **A single spell practice card comes out to 17.7 seconds** — a natural length
  for one card, and off by an order of magnitude from every other replay (a wrong
  record length would break this).
- **A game over early in stage 3 (th6_05) comes to just 30 seconds of stage 3**,
  while **a game over late in stage 3 (th6_06) comes to 254 seconds of stage 3**
  — matching the ground truth's "early/late" description.
- A full 6-stage clear runs 24-29 minutes and a full Extra clear runs 10-13
  minutes, consistent with actual play time in the original game.

For structural coverage, all 13 files / 32 stages were mechanically checked for
"(stage block length − header length − 8) is a multiple of 12" and "the sentinel
lands exactly at the expected position" — both held on every one.

## 6. Unknowns and data that would help

The following could not be resolved with the data on hand. Where **more replays
would settle it**, that is noted.

1. **Clear detection (`cleared`).** As with th06, the stage offset array only
   tells you "stage 6 was reached" and cannot distinguish a full clear from a
   game over on stage 6. A byte-by-byte scan of the whole fixed header looking
   for a position that cleanly separates the 4 cleared files from the 3 uncleared
   ones found no candidate beyond coincidental matches in the score's high bytes.
   → **A replay that games over on stage 6 (or Extra)** would likely pin down the
   flag's location. One of each variant would help.
2. **New Classic spell practice's difficulty.** Since 0x08 is overwritten by the
   spell index, it cannot be read from the file, so `difficulty: null` is
   returned. However, **the spell index itself might be numbered including
   difficulty** (the original game has 64 spell cards, and `No.108` exceeds
   that). → **2-3 spell practice replays of the same spell at different
   difficulties** would show whether the index is assigned per difficulty or
   whether the difficulty is stored somewhere else.
3. **New Classic game mode value 2.** Unobserved. Guessed to be a stage practice
   mode, but unconfirmed, so the parser passes unknown modes through as
   `stage: "Mode 2"`. → **A stage practice replay**, if one exists, would settle
   this.
4. **Spell practice's stage index.** The one sample available (`No.108`) was
   written at index 5 (= stage 6) of the stage offset array. Whether this means
   "the stage the spell belongs to" or spell practice always uses a fixed index
   cannot be determined from a single sample. The parser assumes the former and
   returns `splits[0].stage = 6`. → **A practice replay for a spell on a
   different stage** would settle this.
5. **Challenge mode's hit count.** The mode itself is identifiable from 0x06, but
   no field corresponding to the hit count the game is supposed to record could
   be found. The stage header's lives field stays fixed at 2 and never moves.
6. **The lag rate is not exposed.** `ParsedReplay` has no field for it, so
   although the offset is known, the parser does not read it (true of all three
   variants).
7. **The meaning of New Classic's checksum seed** (§3.2). Empirically holds on
   7/7 files.
8. **Input key bit assignment.** Beyond `0x001` being shoot and `0x100` always
   being set, this was not pursued further, since it is not needed to compute
   `frameCount`.

## 7. Impact on Sattori

- **Recording is not supported.** Neither is listed in `SUPPORTED_GAME_IDS`
  (`packages/shared/src/games.ts`), so uploading one is rejected as an
  unsupported title. This is intentional: **if both were accepted as th06,
  recording would always fail, because Classic's replays cannot be played back
  by the ver 1.02h title assets** (the older version does not even recognize a
  1.03 replay as a file).
- Since replays are saved under the game directory's `replay/`, they do not fit
  either of the two groups `/replay-help` describes (install-directory-relative
  vs. `%APPDATA%`), and so are explicitly excluded from the help page's title
  list (`REMAKE_GAME_IDS`). Supporting recording later will need dedicated
  guidance and icons (e.g. `apps/web/public/icons/th06c.png`).
- Conversely, **carrying an older-version replay into the new version reportedly
  works**, so if Classic is made a supported recording title in the future,
  consolidating th06 (1.02h)'s recording pipeline onto Classic (playing both back
  under 1.03) is worth considering.
