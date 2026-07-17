/**
 * このパッケージが認識する東方Project本編のタイトル識別子。
 * `packages/shared` の `GameId` とは独立している（本パッケージは
 * 単体でOSS公開できることを目標にしており、Sattori固有の型に依存しない）。
 *
 * th13 (神霊廟) と th14 (輝針城) は同一のマジックバイト `t13r` を使い、
 * ヘッダ内のバージョンバイトで判別する（threplay 由来、コード内コメント参照）。
 */
export const REPLAY_GAME_IDS = [
  "th06",
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
  // th19 (東方獣王園) にはリプレイ保存機能自体が存在しないため対象外
  // （.rpy ファイルが存在しない）。
  "th20",
] as const;

export type ReplayGameId = (typeof REPLAY_GAME_IDS)[number];

export const REPLAY_GAME_TITLES: Record<ReplayGameId, string> = {
  th06: "東方紅魔郷 ～ the Embodiment of Scarlet Devil",
  th07: "東方妖々夢 ～ Perfect Cherry Blossom",
  th08: "東方永夜抄 ～ Imperishable Night",
  th09: "東方花映塚 ～ Phantasmagoria of Flower View",
  th095: "東方文花帖 ～ Shoot the Bullet",
  th10: "東方風神録 ～ Mountain of Faith",
  th11: "東方地霊殿 ～ Subterranean Animism",
  th12: "東方星蓮船 ～ Undefined Fantastic Object",
  th125: "ダブルスポイラー ～ 東方文花帖",
  th128: "妖精大戦争 ～ 東方三月精",
  th13: "東方神霊廟 ～ Ten Desires",
  th14: "東方輝針城 ～ Double Dealing Character",
  th143: "弾幕アマノジャク ～ Impossible Spell Card",
  th15: "東方紺珠伝 ～ Legacy of Lunatic Kingdom",
  th16: "東方天空璋 ～ Hidden Star in Four Seasons",
  th165: "秘封ナイトメアダイアリー ～ Violet Detector",
  th17: "東方鬼形獣 ～ Wily Beast and Weakest Creature",
  th18: "東方虹龍洞 ～ Unconnected Marketeers",
  // th19 (東方獣王園) はリプレイ保存機能なし
  th20: "東方錦上京 ～ Fossilized Wonders",
};
