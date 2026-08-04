import type { ReplayGameId } from "./game-ids.js";

/**
 * Localized display names for a `ParsedReplay.character` value. `null` when
 * the raw value doesn't match any known form for that game (e.g. a value
 * written by a fan patch/MOD this package hasn't seen yet) — callers should
 * fall back to showing `character` itself in that case.
 */
export interface LocalizedCharacterName {
  ja: string | null;
  en: string | null;
}

const NOT_LOCALIZED: LocalizedCharacterName = { ja: null, en: null };

type CharacterTable = Record<string, LocalizedCharacterName>;

/**
 * Source for all tables below: [n-rook/thscoreboard](https://github.com/n-rook/thscoreboard)
 * (the software behind [Silent Selene](https://www.silentselene.net/), see this
 * package's README "Related work"), specifically `GetShotName`/`GetCharacterName`
 * in `replays/game_ids.py` (which raw values are valid per game, and their English
 * label) and the `ja`/`en_US` gettext catalogs under `locale` (`LC_MESSAGES/django.po`)
 * (the localized strings themselves — thscoreboard's `en_US` catalog is mostly
 * identical to the bare `msgid`, but not always, e.g. th11 spells out the partner
 * character in parenthesis).
 *
 * Every raw value below (the table keys) was additionally cross-checked against
 * real replays fetched from Silent Selene's API (see `.agents/skills/silent-selene/`),
 * comparing this package's own `character` output against Silent Selene's
 * independently-sourced "Shot" metadata field for the same replay — not just
 * copied from thscoreboard's source. th17's inconsistent internal spacing
 * (`"Reimu W"` vs `"MarisaW"`, no space) is real, present verbatim in the file,
 * confirmed the same way.
 */
const TH06_TH07_SHARED: CharacterTable = {
  ReimuA: { ja: "霊符", en: "Reimu A" },
  ReimuB: { ja: "夢符", en: "Reimu B" },
  MarisaA: { ja: "魔符", en: "Marisa A" },
  MarisaB: { ja: "恋符", en: "Marisa B" },
};

/**
 * th08 (東方永夜抄, IN) is the one exception to "raw value = ASCII shot id"
 * among th06-th18: unlike every other game here, Sattori's `character` for th08
 * comes directly from a Shift_JIS display-name field in the replay's USER
 * section (see `games/th08.ts`), not from an internal shot-id enum — so the
 * table keys here are the exact Japanese strings the game itself writes
 * (full-width space between surname/given name for solo characters, full-width
 * "＆" with no space for pairs, and abbreviated Western names for Alice/Remilia
 * — e.g. "アリス・Ｍ" rather than the full "アリス・マーガトロイド", matching a
 * fixed-width field in the original game), not a normalized/romanized form.
 */
const TH08: CharacterTable = {
  "博麗　霊夢": { ja: "霊夢", en: "Reimu" },
  "霧雨　魔理沙": { ja: "魔理沙", en: "Marisa" },
  "十六夜　咲夜": { ja: "咲夜", en: "Sakuya" },
  "八雲　紫": { ja: "紫", en: "Yukari" },
  "西行寺　幽々子": { ja: "幽々子", en: "Yuyuko" },
  "魂魄　妖夢": { ja: "妖夢", en: "Youmu" },
  "アリス・Ｍ": { ja: "アリス", en: "Alice" },
  "レミリア・Ｓ": { ja: "レミリア", en: "Remilia" },
  "霊夢＆紫": { ja: "結界組", en: "Reimu & Yukari" },
  "魔理沙＆アリス": { ja: "詠唱組", en: "Marisa & Alice" },
  "咲夜＆レミリア": { ja: "紅魔組", en: "Sakuya & Remilia" },
  "妖夢＆幽々子": { ja: "幽冥組", en: "Youmu & Yuyuko" },
};

const TH09: CharacterTable = {
  Reimu: { ja: "霊夢", en: "Reimu" },
  Marisa: { ja: "魔理沙", en: "Marisa" },
  Sakuya: { ja: "咲夜", en: "Sakuya" },
  Youmu: { ja: "妖夢", en: "Youmu" },
  Reisen: { ja: "鈴仙", en: "Reisen" },
  Cirno: { ja: "チルノ", en: "Cirno" },
  Lyrica: { ja: "リリカ", en: "Lyrica" },
  Mystia: { ja: "ミスティア", en: "Mystia" },
  Tewi: { ja: "てゐ", en: "Tewi" },
  Yuuka: { ja: "幽香", en: "Yuuka" },
  Aya: { ja: "文", en: "Aya" },
  Medicine: { ja: "メディスン", en: "Medicine" },
  Komachi: { ja: "小町", en: "Komachi" },
  Eiki: { ja: "映姫", en: "Eiki" },
  Merlin: { ja: "メルラン", en: "Merlin" },
  Lunasa: { ja: "ルナサ", en: "Lunasa" },
};

const TH10: CharacterTable = {
  ReimuA: { ja: "霊夢A", en: "Reimu A" },
  ReimuB: { ja: "霊夢B", en: "Reimu B" },
  ReimuC: { ja: "霊夢C", en: "Reimu C" },
  MarisaA: { ja: "魔理沙A", en: "Marisa A" },
  MarisaB: { ja: "魔理沙B", en: "Marisa B" },
  MarisaC: { ja: "魔理沙C", en: "Marisa C" },
};

/**
 * th11 (東方地霊殿, SA) shares th10's raw ASCII shot ids, but thscoreboard's
 * English label additionally spells out each shot's "possessed" sub-character
 * in parenthesis (the ja label doesn't); kept as-is rather than normalized to
 * th10's plain "Reimu A" form since that's genuinely how thscoreboard's
 * (community-maintained) translation distinguishes them.
 */
const TH11: CharacterTable = {
  ReimuA: { ja: "霊夢A", en: "Reimu A (Yukari)" },
  ReimuB: { ja: "霊夢B", en: "Reimu B (Suika)" },
  ReimuC: { ja: "霊夢C", en: "Reimu C (Aya)" },
  MarisaA: { ja: "魔理沙A", en: "Marisa A (Alice)" },
  MarisaB: { ja: "魔理沙B", en: "Marisa B (Patchouli)" },
  MarisaC: { ja: "魔理沙C", en: "Marisa C (Nitori)" },
};

/**
 * th12 (東方星蓮船, UFO)'s ja labels are the shot's spell-card-type name
 * (as displayed on the JP character select screen), matching th06/07's
 * convention rather than th10's "character + letter" one — and don't line up
 * letter-for-letter with th06 (Reimu A here is "夢符", not "霊符").
 */
const TH12: CharacterTable = {
  ReimuA: { ja: "夢符", en: "Reimu A" },
  ReimuB: { ja: "霊符", en: "Reimu B" },
  MarisaA: { ja: "恋符", en: "Marisa A" },
  MarisaB: { ja: "魔符", en: "Marisa B" },
  SanaeA: { ja: "蛇符", en: "Sanae A" },
  SanaeB: { ja: "蛙符", en: "Sanae B" },
};

const TH13: CharacterTable = {
  Reimu: { ja: "霊夢", en: "Reimu" },
  Marisa: { ja: "魔理沙", en: "Marisa" },
  Sanae: { ja: "早苗", en: "Sanae" },
  Youmu: { ja: "妖夢", en: "Youmu" },
};

const TH14: CharacterTable = {
  ReimuA: { ja: "霊夢A", en: "Reimu A" },
  ReimuB: { ja: "霊夢B", en: "Reimu B" },
  MarisaA: { ja: "魔理沙A", en: "Marisa A" },
  MarisaB: { ja: "魔理沙B", en: "Marisa B" },
  SakuyaA: { ja: "咲夜A", en: "Sakuya A" },
  SakuyaB: { ja: "咲夜B", en: "Sakuya B" },
};

const TH15: CharacterTable = {
  Reimu: { ja: "霊夢", en: "Reimu" },
  Marisa: { ja: "魔理沙", en: "Marisa" },
  Sanae: { ja: "早苗", en: "Sanae" },
  Reisen: { ja: "鈴仙", en: "Reisen" },
};

/**
 * th16 (東方天空璋, HSiFS) also has a per-season shot variant (spring/summer/
 * autumn/winter), but Sattori's `character` field for th16 already only ever
 * carries the base character name (season is exposed separately via
 * `splits[].additional.season`, see `games/th16.ts`) — so this table only
 * needs the 4 base names, not the 16 season variants thscoreboard tracks.
 */
const TH16: CharacterTable = {
  Reimu: { ja: "霊夢", en: "Reimu" },
  Marisa: { ja: "魔理沙", en: "Marisa" },
  Cirno: { ja: "チルノ", en: "Cirno" },
  Aya: { ja: "文", en: "Aya" },
};

/**
 * th17 (東方鬼形獣, WBaWC) raw values carry an inconsistent space before the
 * animal-spirit letter suffix depending on name length (`"Reimu W"`/`"Youmu W"`
 * with a space, `"MarisaW"` without) — this is exactly what the replay file
 * contains (see the comment atop this file), not a normalization bug, so both
 * forms are listed verbatim as separate keys.
 */
const TH17: CharacterTable = {
  "Reimu W": { ja: "霊夢W", en: "Reimu Wolf" },
  "Reimu O": { ja: "霊夢O", en: "Reimu Otter" },
  "Reimu E": { ja: "霊夢E", en: "Reimu Eagle" },
  MarisaW: { ja: "魔理沙W", en: "Marisa Wolf" },
  MarisaO: { ja: "魔理沙O", en: "Marisa Otter" },
  MarisaE: { ja: "魔理沙E", en: "Marisa Eagle" },
  "Youmu W": { ja: "妖夢W", en: "Youmu Wolf" },
  "Youmu O": { ja: "妖夢O", en: "Youmu Otter" },
  "Youmu E": { ja: "妖夢E", en: "Youmu Eagle" },
};

const TH18: CharacterTable = {
  Reimu: { ja: "霊夢", en: "Reimu" },
  Marisa: { ja: "魔理沙", en: "Marisa" },
  Sakuya: { ja: "咲夜", en: "Sakuya" },
  Sanae: { ja: "早苗", en: "Sanae" },
};

/**
 * th20 (東方錦上京, FW)'s `character` used to be read from a USER-section text
 * field that turned out to be unreliable in real replays (garbage values like
 * `"test"`, or words belonging to a different field like `"Hard"`) — fixed in
 * `games/th20.ts` to instead derive `character` from the decompressed body's
 * numeric `shot`/`stones[0]` fields, the same approach thscoreboard's own th20
 * parser uses. `character` is now always one of the 16 `"<Reimu|Marisa><stone
 * color>"` forms below (e.g. `"ReimuRed"`, `"MarisaGreen2"`), matching
 * thscoreboard's `GetShotName` raw shot ids for th20 exactly.
 */
const TH20: CharacterTable = {
  ReimuRed: { ja: "霊夢 赤1", en: "Reimu Red" },
  ReimuRed2: { ja: "霊夢 赤2", en: "Reimu Red2" },
  ReimuBlue: { ja: "霊夢 青1", en: "Reimu Blue" },
  ReimuBlue2: { ja: "霊夢 青2", en: "Reimu Blue2" },
  ReimuYellow: { ja: "霊夢 黄1", en: "Reimu Yellow" },
  ReimuYellow2: { ja: "霊夢 黄2", en: "Reimu Yellow2" },
  ReimuGreen: { ja: "霊夢 緑1", en: "Reimu Green" },
  ReimuGreen2: { ja: "霊夢 緑2", en: "Reimu Green2" },
  MarisaRed: { ja: "魔理沙 赤1", en: "Marisa Red" },
  MarisaRed2: { ja: "魔理沙 赤2", en: "Marisa Red2" },
  MarisaBlue: { ja: "魔理沙 青1", en: "Marisa Blue" },
  MarisaBlue2: { ja: "魔理沙 青2", en: "Marisa Blue2" },
  MarisaYellow: { ja: "魔理沙 黄1", en: "Marisa Yellow" },
  MarisaYellow2: { ja: "魔理沙 黄2", en: "Marisa Yellow2" },
  MarisaGreen: { ja: "魔理沙 緑1", en: "Marisa Green" },
  MarisaGreen2: { ja: "魔理沙 緑2", en: "Marisa Green2" },
};

/** th125 (ダブルスポイラー, DS) has only one playable character, Aya, same as th095. */
const TH125: CharacterTable = {
  Aya: { ja: "文", en: "Aya" },
};

const CHARACTER_TABLES: Partial<Record<ReplayGameId, CharacterTable>> = {
  th06: TH06_TH07_SHARED,
  th07: { ...TH06_TH07_SHARED, SakuyaA: { ja: "幻符", en: "Sakuya A" }, SakuyaB: { ja: "時符", en: "Sakuya B" } },
  th08: TH08,
  th09: TH09,
  th10: TH10,
  th11: TH11,
  th12: TH12,
  th125: TH125,
  th13: TH13,
  th14: TH14,
  th15: TH15,
  th16: TH16,
  th17: TH17,
  th18: TH18,
  th20: TH20,
};

/**
 * Looks up the localized display names for a `ParsedReplay.character` value.
 * Returns `{ ja: null, en: null }` (never throws) when `character` is `null`
 * or doesn't match any known raw form for that game.
 */
export function localizeCharacterName(game: ReplayGameId, character: string | null): LocalizedCharacterName {
  if (character === null) return NOT_LOCALIZED;
  return CHARACTER_TABLES[game]?.[character] ?? NOT_LOCALIZED;
}
