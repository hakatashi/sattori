/**
 * 東方Projectのナンバリングタイトル識別子。
 * リプレイファイル先頭のマジックバイトと対応づける（packages/replay-parser で使用）。
 */
export const GAME_IDS = [
  "th06", // 東方紅魔郷
  "th07", // 東方妖々夢
  "th08", // 東方永夜抄
  "th09", // 東方花映塚
  "th095", // 東方文花帖
  "th10", // 東方風神録
  "th11", // 東方地霊殿
  "th12", // 東方星蓮船
  "th125", // ダブルスポイラー
  "th128", // 妖精大戦争
  "th13", // 東方神霊廟
  "th14", // 東方輝針城
  "th143", // 弾幕アマノジャク
  "th15", // 東方紺珠伝
  "th16", // 東方天空璋
  "th165", // 秘封ナイトメアダイアリー
  "th17", // 東方鬼形獣
  "th18", // 東方虹龍洞
  "th20", // 東方錦上京（th19 = 獣王園はリプレイ保存機能がないため対象外）
] as const;

export type GameId = (typeof GAME_IDS)[number];

/** 表示用の日本語タイトル名。 */
export const GAME_TITLES: Record<GameId, string> = {
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
  th20: "東方錦上京 ～ Fossilized Wonders",
};

/**
 * フェーズ1で録画に対応しているタイトル。
 * PoC（touhou-recorder）で E2E 実証済みなのは th07・th08 のみ。
 * フェーズ1の初期実装では th07 のみを有効とする。
 */
export const SUPPORTED_GAME_IDS: readonly GameId[] = ["th07"];

export function isSupportedGame(game: GameId): boolean {
  return SUPPORTED_GAME_IDS.includes(game);
}
