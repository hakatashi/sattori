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

export interface GameTitleInfo {
  id: GameId;
  fullName: string;
  japaneseName: string;
  englishName: string;
  japaneseShortName: string;
  englishShortName: string;
}

/** 表示用の日本語タイトル名。 */
export const GAME_TITLES: Record<GameId, GameTitleInfo> = {
  th06: {
    id: "th06",
    fullName: "東方紅魔郷 ～ the Embodiment of Scarlet Devil.",
    japaneseName: "東方紅魔郷",
    englishName: "Embodiment of Scarlet Devil",
    japaneseShortName: "紅",
    englishShortName: "EoSD",
  },
  th07: {
    id: "th07",
    fullName: "東方妖々夢 ～ Perfect Cherry Blossom.",
    japaneseName: "東方妖々夢",
    englishName: "Perfect Cherry Blossom",
    japaneseShortName: "妖",
    englishShortName: "PCB",
  },
  th08: {
    id: "th08",
    fullName: "東方永夜抄 ～ Imperishable Night.",
    japaneseName: "東方永夜抄",
    englishName: "Imperishable Night",
    japaneseShortName: "永",
    englishShortName: "IN",
  },
  th09: {
    id: "th09",
    fullName: "東方花映塚 ～ Phantasmagoria of Flower View.",
    japaneseName: "東方花映塚",
    englishName: "Phantasmagoria of Flower View",
    japaneseShortName: "花",
    englishShortName: "PoFV",
  },
  th095: {
    id: "th095",
    fullName: "東方文花帖 ～ Shoot the Bullet.",
    japaneseName: "東方文花帖",
    englishName: "Shoot the Bullet",
    japaneseShortName: "文",
    englishShortName: "StB",
  },
  th10: {
    id: "th10",
    fullName: "東方風神録 ～ Mountain of Faith.",
    japaneseName: "東方風神録",
    englishName: "Mountain of Faith",
    japaneseShortName: "風",
    englishShortName: "MoF",
  },
  th11: {
    id: "th11",
    fullName: "東方地霊殿 ～ Subterranean Animism.",
    japaneseName: "東方地霊殿",
    englishName: "Subterranean Animism",
    japaneseShortName: "地",
    englishShortName: "SA",
  },
  th12: {
    id: "th12",
    fullName: "東方星蓮船 ～ Undefined Fantastic Object.",
    japaneseName: "東方星蓮船",
    englishName: "Undefined Fantastic Object",
    japaneseShortName: "星",
    englishShortName: "UFO",
  },
  th125: {
    id: "th125",
    fullName: "ダブルスポイラー ～ 東方文花帖",
    japaneseName: "ダブルスポイラー",
    englishName: "Double Spoiler",
    japaneseShortName: "DS",
    englishShortName: "DS",
  },
  th128: {
    id: "th128",
    fullName: "妖精大戦争 ～ 東方三月精",
    japaneseName: "妖精大戦争",
    englishName: "Fairy Wars",
    japaneseShortName: "戦",
    englishShortName: "FW",
  },
  th13: {
    id: "th13",
    fullName: "東方神霊廟 ～ Ten Desires.",
    japaneseName: "東方神霊廟",
    englishName: "Ten Desires",
    japaneseShortName: "神",
    englishShortName: "TD",
  },
  th14: {
    id: "th14",
    fullName: "東方輝針城 ～ Double Dealing Character.",
    japaneseName: "東方輝針城",
    englishName: "Double Dealing Character",
    japaneseShortName: "輝",
    englishShortName: "DDC",
  },
  th143: {
    id: "th143",
    fullName: "弾幕アマノジャク ～ Impossible Spell Card.",
    japaneseName: "弾幕アマノジャク",
    englishName: "Impossible Spell Card",
    japaneseShortName: "ア",
    englishShortName: "ISC",
  },
  th15: {
    id: "th15",
    fullName: "東方紺珠伝 ～ Legacy of Lunatic Kingdom.",
    japaneseName: "東方紺珠伝",
    englishName: "Legacy of Lunatic Kingdom",
    japaneseShortName: "紺",
    englishShortName: "LoLK",
  },
  th16: {
    id: "th16",
    fullName: "東方天空璋 ～ Hidden Star in Four Seasons.",
    japaneseName: "東方天空璋",
    englishName: "Hidden Star in Four Seasons",
    japaneseShortName: "天",
    englishShortName: "HSiFS",
  },
  th165: {
    id: "th165",
    fullName: "秘封ナイトメアダイアリー ～ Violet Detector.",
    japaneseName: "秘封ナイトメアダイアリー",
    englishName: "Violet Detector",
    japaneseShortName: "秘",
    englishShortName: "VD",
  },
  th17: {
    id: "th17",
    fullName: "東方鬼形獣 ～ Wily Beast and Weakest Creature.",
    japaneseName: "東方鬼形獣",
    englishName: "Wily Beast and Weakest Creature",
    japaneseShortName: "鬼",
    englishShortName: "WBaWC",
  },
  th18: {
    id: "th18",
    fullName: "東方虹龍洞 ～ Unconnected Marketeers.",
    japaneseName: "東方虹龍洞",
    englishName: "Unconnected Marketeers",
    japaneseShortName: "虹",
    englishShortName: "UM",
  },
  th20: {
    id: "th20",
    fullName: "東方錦上京 ～ Fossilized Wonders.",
    japaneseName: "東方錦上京",
    englishName: "Fossilized Wonders",
    japaneseShortName: "錦",
    englishShortName: "FoW",
  },
};

/**
 * 録画に対応しているタイトル。
 * th07（フェーズ1）・th08（Issue #13）・th06（MOD 移植・VsyncPatch 併用による
 * wined3d白画面ハング回避・ワーカー拡張）に続き、th11（GetKeyboardStateフックに
 * よるメニュー自動操作・画面静止検知のみでの終了判定・Pause Menu明滅カーソルの
 * 除外マスク等、touhou-recorder reports/35〜39）、th20（%APPDATA%配下のcfg/replay・
 * 1280x960ウィンドウ・Presentフックによるfps制御、touhou-recorder reports/44〜48、
 * Issue #87）、th10（DIK経由の入力注入・VsyncPatchによる「バグマリ」修正オプション・
 * 絞り込み領域でのテンプレート照合、touhou-recorder reports/56〜60、Issue #75）、
 * th12（DIK経由の入力注入とth11型メニュー構造のハイブリッド仕様・ウィンドウ最小化
 * バグ対策・VsyncPatch常時有効化、touhou-recorder reports/61〜67、Issue #76）、
 * th09（対戦形式(1P/2P split-screen)・DIK経由の入力注入・ud0000タブ方式・
 * スコアRVA未特定のためlifeのみ監視、touhou-recorder reports/68〜69、Issue #73）を
 * 追加した。
 * PoC（touhou-recorder）で E2E 実証済みなのはこの8本のみで、他タイトルは
 * MOD 移植（録画対応）が未着手（AGENTS.md 参照）。
 */
export const SUPPORTED_GAME_IDS: readonly GameId[] = [
  "th06", "th07", "th08", "th09", "th10", "th11", "th12", "th20",
];

export function isSupportedGame(game: GameId): boolean {
  return SUPPORTED_GAME_IDS.includes(game);
}
