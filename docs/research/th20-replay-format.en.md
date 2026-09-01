# Reverse-engineering the body format of th20 (東方錦上京, Fossilized Wonders) replays

Investigated: 2026-09-02 / Tracking issue: #176 / Implemented in:
`packages/replay-parser/src/games/th20.ts`
/ 日本語版: [`th20-replay-format.md`](th20-replay-format.md)

*This is an English translation of the Japanese document linked above. If the two
ever disagree, the Japanese one is authoritative.*

## 1. What this investigates

th20 was the one title for which `@sattori/touhou-replay-parser` could not
produce **`splits` (the per-stage breakdown) or `frameCount` (total playback
frames)**. Every prior project was in the same position:

- raviddog/threplay (the upstream this package was ported from) stops at th18.
- n-rook/thscoreboard (the backend behind [Silent
  Selene](https://www.silentselene.net/)) defines only a `Header` in
  `replays/kaitai_parsers/th20.py` — there is no `Stage` class.
- Consequently every th20 replay page on Silent Selene, including the top-ranked
  ones, still renders "Stage split information is unavailable for this replay."

In other words, **no public description of the structure of th20's body (the
bytes after XOR+LZSS decompression) appeared to exist**. This investigation
reverse-engineered it.

Being able to read `frameCount` also fills in
`ReplayInfo.estimatedDurationSeconds` (`packages/shared/src/replay.ts`), which is
the denominator of the progress indicator shown while a replay is being recorded.
th20 is a title Sattori already records, so this is a user-visible improvement as
well.

## 2. Data used

| Source | Files | Purpose |
| --- | --- | --- |
| Silent Selene (`.agents/skills/silent-selene/`; sampled at random across every difficulty plus Extra) | 63 | Checking the structure generalises |
| Completed th20 jobs from Sattori production (uploaded `.rpy` files in S3) | 25 | Same, plus cross-checking against the recorded video |
| Fixtures checked into the repo, `test-fixtures/th20/` | 7 | Same |

95 files were fetched, but some are duplicates — a replay uploaded to Silent
Selene had also been submitted as a production job, and so on — so **88 files with
distinct contents, totalling 420 stage records**. The verification figures below
are quoted after that de-duplication.

**Five of the production jobs still had their recorded video in S3**, so the
video's frame count and on-screen HUD could be used as ground truth (the other 20
videos had already been deleted). For jobs `c5b06095` (Lunatic full clear) and
`a1ef72c0` (Lunatic full clear; byte-identical to the current #1 Lunatic record on
Silent Selene), a human had also played the videos back and written down the start
time and score of each stage — that hand measurement is where the analysis
started.

The checked-in fixtures cover full clears (Hard / Easy / Lunatic) and a game over
(reaching stage 5), plus three fundamentally different recording modes added
later: **an Extra stage, a spell practice run, and a stage practice run**. That
the same walk works unchanged on all of them is itself evidence the structure is
right.

## 3. The structure

After XOR+LZSS decompression (the return value of `decodeModernBody(..., 48)`) the
body looks like this:

```
[0x100-byte header][stage record][input log][stage record][input log]...
```

**A stage record is a fixed 0x2a0 (672) bytes**, immediately followed by a
variable-length input log. The log's length is stored in the record's
`INPUT_SIZE` field, so adding it to the record size walks you to the start of the
next record. The number of stages is at header offset 0xd4.

### 3.1 Body header (0x00-0xff)

| Offset | Type | Meaning |
| --- | --- | --- |
| 0x00 | 16 bytes | Player name (Shift_JIS, NUL-padded; uninitialised garbage sometimes trails it) |
| 0x10 | u64 | Recording time (Unix epoch seconds, UTC). Same kind of value as th10-th18's `timestamp` |
| 0x18 | u64 | Final score ÷ 10 |
| 0xd0 | f32 | Slowdown rate (%). Matches Silent Selene's "Slowdown" display |
| 0xd4 | u32 | Number of stage records |
| 0xd8 | u32 | Shot (0 = Reimu / 1 = Marisa). Already used before this investigation |
| 0xdc | u32 | Stone (index into `STONE_NAMES`). Already used before this investigation |

The timestamp at 0x10 was cross-checked against the USER section's `date` string
(which is local time) on 86 files: **every difference came out as a whole number
of hours**, and the distribution — UTC+9 on 47, UTC+8 on 22, UTC+7 on 4, and so
on — looks like a real spread of time zones. The layout is the same "fixed-width
`name` immediately followed by an epoch" shape th10-th18 use; the only difference
is that `name` is 16 bytes here (the same width as th17/th18).

### 3.2 Stage record (fixed 0x2a0 bytes)

**The record is a snapshot taken at the *start* of the stage** — the same
convention as th10-th18. So the score on the "Stage N" row is the score carried in
from the end of stage N-1, which is exactly what the game's own replay selection
screen shows on that row. A full clear has 6 records (Extra is a single record
with stage = 7; practice modes have just the one record for that stage), and
**there is no record for the state at the end of the final stage**.

| Offset | Type | Meaning | Exposed as |
| --- | --- | --- | --- |
| 0x000 | u32 | Stage number (1-6; 7 for Extra) | `splits[].stage` |
| 0x004 | u32 | RNG seed | not exposed |
| 0x008 | u32 | Frame count of this stage | `splits[].frameCount` |
| 0x00c | u32 | Byte length of the input log that follows | walking + sanity check |
| 0x010 / 0x014 | u32 | Looks like the player position (1/128 fixed point; on stage 1, X = centre and Y = 400) | not exposed |
| 0x070 | u64 | Score at the start of the stage ÷ 10 | `splits[].score` |
| 0x0a0 | u32 | 霊力 (power) ×100 (100 = 1.00 at the start, capped at 400 = 4.00) | `splits[].power` |
| 0x0a4 | u32 | Maximum power ×100 (always 400) | verified invariant only |
| 0x0ac | u32 | Graze count (cumulative; always 0 on the stage 1 record) | `splits[].graze` |
| 0x0b0 | u32 | Always 10000 | not exposed |
| 0x0b4 | u32 | **異変値 ×5000** (saturates at 1,000,000, i.e. "200.00" on screen) | `splits[].piv` |
| 0x0b8 | u32 | Always 5000 (the display scale of 異変値) | not exposed |
| 0x0d4-0x0e0 | u32×4 | Per-colour 石 (stone) gauge (0-1000) | not exposed |
| 0x0e4-0x0f0 | u32×4 | Looks like per-colour stones currently held (0-4) | not exposed |
| 0x0f4-0x100 | u32×4 | **Per-colour stone level, in the order red, blue, yellow, green** | `splits[].additional.stones` |
| 0x104 | u32 | Total stone level; always equals the sum of the four above | `splits[].additional.stonesTotal` |
| 0x128 | u32 | 残り人数 (lives) | `splits[].lives.count` |
| 0x12c | u32 | Maximum lives (always 7, matching the number of heart slots the HUD draws) | verified invariant only |
| 0x130 | u32 | Life fragments, 0-2 out of 3 | `splits[].lives.pieces` |
| 0x134 | u32 | Cumulative miss (death) count; always 0 on the stage 1 record | `splits[].additional.misses` |
| 0x13c | u32 | スペルカード (bombs) | `splits[].bombs.count` |
| 0x140 | u32 | Bomb fragments, 0-2 out of 3 | `splits[].bombs.pieces` |
| 0x148 | u32 | Maximum bombs (always 7) | verified invariant only |

The order of the four values at 0x0f4-0x100 — i.e. which slot is which colour —
was pinned down by **comparing them against the per-anomaly-enemy levels printed
on the in-game stage result screen**: the order is **red, blue, yellow, green**.
The parser returns them as an object, `{ red, blue, yellow, green }`, rather than
an array, so callers do not have to carry that ordering knowledge around.

**Fields deliberately left unidentified:**

- 0x01c-0x06c: from stage 2 onward this holds 3-8 values in the 8-20 million
  range followed by zero padding. On the stage 1 record the same area contains
  arithmetic-progression-looking garbage (uninitialised memory).
- 0x0cc / 0x0d0: the former is an arbitrary value; the latter is always a
  multiple of 50 and caps at 5000. Possibly related to the 異変値 gain rate.
- 0x138 / 0x14c / 0x150: **already non-zero on the stage 1 record** (e.g. 49 /
  7873 / 7). The same player's replay from three days earlier has much smaller
  values (6 / 603 / 1) and they also increase during a run, so these look like
  save-file-wide cumulative statistics being snapshotted.
- 0x298 / 0x29c: f32, values around 0.3-0.8.

### 3.3 Input log

6 bytes per frame (the layout looks like `[u16 current input][u16 pressed this
frame][u16 released this frame]`), **plus a 1-byte marker every 30 frames**. That
is:

```
input log length = 6 × frames + ceil(frames / 30)
```

This held exactly for all 420 records — including the boundary case where the
frame count is an exact multiple of 30 and the term is `ceil` rather than `+1`,
which a dozen or so records actually hit. **Because the frame count and the log
length are redundant, a mismatch means you are no longer looking at a stage
record**, and the implementation's `isPlausibleRecord()` uses exactly that as the
walk's stop condition.

## 4. Verification

### 4.1 Structural (88 files / 420 records)

- Walking from 0x100 and adding `0x2a0 + INPUT_SIZE` each time **landed exactly on
  the end of the decompressed body for every file** — no bytes left over, none
  missing.
- The record count always equalled the header's 0xd4 field.
- The only stage sequences that occur are `(1,2,3,4,5,6)`, `(1,2,3,4,5)`,
  `(1,2,3,4)`, `(1)`, `(5)`, `(6)`, `(7)` — full clear, game over in stage 5, in
  stage 4, in stage 1, practice (a single record for that stage), and Extra.
- The score at 0x18 matched the USER section's score string on all 86 files
  checked.
- Constants verified as invariant: max power 400, max lives 7, max bombs 7,
  0x0b0 = 10000, 0x0b8 = 5000.
- Monotonicity: score, graze and miss count never decrease. The per-colour stone
  levels always sum to 0x104.

### 4.2 Frame counts, against the recorded video

Converting the per-stage frame counts of job `c5b06095` (100,410 frames) to
seconds at 60fps gives 191.9 / 217.7 / 272.5 / 280.0 / 349.5 / 361.9 s. The stage
lengths read off the video by hand were 193 / 218 / 273 / 280 / 352 / 362 s —
**all six stages agree to within a few seconds**. The whole video is 102,737
frames; the 2,327-frame (38.8 s) excess over the replay's 100,410 frames is the
menu automation at the start plus the lag in detecting the end of the replay.

For job `a1ef72c0` the stage 1-4 boundaries lined up the same way, but the hand
reading of "stage 6 starts at 34:47" was off by about 200 seconds. Extracting that
part of the video at 10-second intervals showed that **the post-stage-5-boss
dialogue appears around 31:40 (roughly the 1900-second mark), immediately followed
by a completely different stage background** — which matches the boundary computed
from the records (112,284 cumulative frames = 31:11, plus the recording start
offset and the accumulated inter-stage drift). The hand reading was wrong; the
records are right.

### 4.3 Against the on-screen HUD

The HUD was read off the frame at the start of stage 2 of job `c5b06095` (the
frame whose score display reads 55,919,200, exactly matching the record's
`score`), plus other boundary frames from that job and from `a1ef72c0`.

| Item | HUD | Record |
| --- | --- | --- |
| 残り人数 (lives) | 2 (fragments 2/3) | 0x128 = 2 / 0x130 = 2 |
| スペルカード (bombs) | 2 (fragments 2/3) | 0x13c = 2 / 0x140 = 2 |
| 霊力 (power) | 4.00 / 4.00 | 0x0a0 = 400 / 0x0a4 = 400 |
| 異変値 | 24.96 | 0x0b4 = 124,837 → ÷5000 = 24.967 |

The `a1ef72c0` side (lives 3 with 1/3 fragments, bombs 7 with 0/3, power 4.00,
異変値 200.00) matched in the same way, and the fact that 異変値 tops out at
200.00 lines up with 0x0b4 topping out at 1,000,000.

## 5. Caveats and limits

- **"0x134 is the miss count" rests on circumstantial evidence.** It is always 0
  on the stage 1 record and never decreases, and the stages where it jumps are
  exactly the ones after which power has dropped below maximum (in th20 dying
  costs power). However, in 19 of 338 stage transitions the drop in lives exceeded
  the increase in this counter, which suggests **th20 has some way of spending
  lives other than dying** (what that is has not been identified). Deaths were not
  re-counted frame by frame.
- **The stage number of a practice record can disagree with the game's own replay
  list.** The checked-in fixture `th20_07.rpy` (a practice clear of Hard stage 6
  only) is listed as "St5" in-game, but both the USER section and the stage record
  say `Stage 6` / `stage = 6` — and that is what **matches what actually happens in
  the replay**. Which field the list's "St5" comes from was not identified (header
  0x098 happens to be 5 for this one record, but it ranges over 0-9 on full clears
  too, so it is unrelated).
- **Only five production jobs could be checked against video.** That said, the
  input-log length formula in §3.3 is an independent confirmation of the frame
  count, and it holds for all 420 records.
- th20's on-screen score display saturates at 9,999,999,990 (`a1ef72c0`'s real
  score is 19,247,977,000). **It is worth checking separately whether the desync
  detection that reads the in-game score via a MOD (issue #103,
  `worker/recording/modlog.py`) false-positives on that overflow** — out of scope
  here, but `a1ef72c0` does in fact carry `desyncDetected: true`.

## 6. See also

- Implementation: `packages/replay-parser/src/games/th20.ts` (the offset table
  above lives there as comments on `TH20_STAGE_RECORD`)
- Package documentation:
  [`packages/replay-parser/README.md`](../../packages/replay-parser/README.md)
- How the replays were fetched from Silent Selene: `.agents/skills/silent-selene/`
