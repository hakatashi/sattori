/**
 * Title identifiers for Touhou Project main games recognized by this package.
 * Independent of `GameId` in `packages/shared` (this package aims to be
 * publishable standalone as OSS, so it does not depend on Sattori-specific types).
 *
 * th13 (東方神霊廟, TD) and th14 (東方輝針城, DDC) share the same
 * magic bytes `t13r` and are distinguished by a version byte in the header
 * (inherited from threplay; see the in-code comments). th06, th06c
 * (東方紅魔郷: Classic) and th06nc (東方紅魔郷: New Classic) likewise share
 * `T6RP` and are distinguished by their version word (see `games/th06.ts`).
 */
export const REPLAY_GAME_IDS = [
  "th06",
  // The two 2026 remakes of th06. They keep th06's `T6RP` magic and are told
  // apart from it (and from each other) by the version word at 0x04 — see
  // `VARIANTS_BY_VERSION` in `games/th06.ts`. They are separate ids rather than
  // a th06 flavour because their replays are *not* interchangeable with the
  // original game's: th06 1.02h refuses to even list a `th06c` file.
  "th06c",
  "th06nc",
  "th07",
  "th08",
  "th09",
  "th095",
  "th10",
  "th11",
  "th12",
  "th125",
  "th128",
  "th13",
  "th14",
  "th143",
  "th15",
  "th16",
  "th165",
  "th17",
  "th18",
  // th19 (東方獣王園, UDoALG) is excluded because it has no replay-saving feature
  // "th19",
  "th20",
] as const;

export type ReplayGameId = (typeof REPLAY_GAME_IDS)[number];

export const REPLAY_GAME_TITLES: Record<ReplayGameId, string> = {
  th06: "東方紅魔郷 ～ the Embodiment of Scarlet Devil.",
  th06c: "東方紅魔郷: Classic ～ the Embodiment of Scarlet Devil.",
  th06nc: "東方紅魔郷: New Classic ～ the Embodiment of Scarlet Devil.",
  th07: "東方妖々夢 ～ Perfect Cherry Blossom.",
  th08: "東方永夜抄 ～ Imperishable Night.",
  th09: "東方花映塚 ～ Phantasmagoria of Flower View.",
  th095: "東方文花帖 ～ Shoot the Bullet.",
  th10: "東方風神録 ～ Mountain of Faith.",
  th11: "東方地霊殿 ～ Subterranean Animism.",
  th12: "東方星蓮船 ～ Undefined Fantastic Object.",
  th125: "ダブルスポイラー ～ 東方文花帖",
  th128: "妖精大戦争 ～ 東方三月精",
  th13: "東方神霊廟 ～ Ten Desires.",
  th14: "東方輝針城 ～ Double Dealing Character.",
  th143: "弾幕アマノジャク ～ Impossible Spell Card.",
  th15: "東方紺珠伝 ～ Legacy of Lunatic Kingdom.",
  th16: "東方天空璋 ～ Hidden Star in Four Seasons.",
  th165: "秘封ナイトメアダイアリー ～ Violet Detector.",
  th17: "東方鬼形獣 ～ Wily Beast and Weakest Creature.",
  th18: "東方虹龍洞 ～ Unconnected Marketeers.",
  // th19 (東方獣王園, UDoALG) is excluded because it has no replay-saving feature
  // th19: "東方獣王園 〜 Unfinished Dream of All Living Ghost.",
  th20: "東方錦上京 ～ Fossilized Wonders.",
};
