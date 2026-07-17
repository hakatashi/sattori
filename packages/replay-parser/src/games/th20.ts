import { ByteReader } from "../byte-reader.js";
import { readModernUserdata } from "../userdata.js";
import { normalizeText, type ParsedReplay } from "../types.js";
import { REPLAY_GAME_TITLES } from "../game-ids.js";

/**
 * t20r (東方錦上京) デコーダ。
 *
 * threplay（本パッケージが移植元とした raviddog/threplay）は th18 までしか
 * カバーしておらず、th20 は本パッケージ独自の調査に基づく実装。
 * USER セクション（JumpToUser(12) 以降のプレイヤー名・日付・キャラクター・
 * 難易度・ステージ・スコア）は th10〜th18 と同一レイアウトであることを
 * 実機リプレイ（`touhou-recorder/games/th20/replay/*.rpy`）とスクリーンショットの
 * 突き合わせで確認済み。
 *
 * 一方、th10〜th18 に存在した「ヘッダオフセット0x1c/0x20のlength/dlengthを
 * 使ったXOR復号+LZSS展開によるステージ内訳」は、th20では手元の3サンプル全てで
 * 展開後サイズが進行状況によらず一定（256バイト）であり、同じ意味のデータとは
 * 考えにくい（おそらくフォーマット変更により該当データの位置が変わっている）。
 * ステージ内訳の構造は未解析のため、splits は常に空配列を返す
 * （name/date/character/difficulty/stage/score は取得可能）。
 */
export function parseTh20(original: Uint8Array): ParsedReplay {
  const userdata = readModernUserdata(new ByteReader(original));

  return {
    game: "th20",
    gameTitle: REPLAY_GAME_TITLES.th20,
    formatVersion: null,
    player: normalizeText(userdata.name),
    date: normalizeText(userdata.date),
    character: normalizeText(userdata.character),
    difficulty: normalizeText(userdata.difficulty),
    stage: normalizeText(userdata.stage),
    score: userdata.score,
    cleared: userdata.stage.includes("Clear"),
    splits: [],
  };
}
