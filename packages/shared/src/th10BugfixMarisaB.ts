import type { GameId } from "./games.js";

/**
 * th10（東方風神録）の既知バグ「バグマリ」——魔理沙Bのパワーが3.00〜3.95の間に
 * あるときショット火力が異常上昇する——をVsyncPatch（`vpatch.ini`の
 * `BugFixTh10Power3`）で修正するオプション（Issue #75）に関する定数と判定。
 *
 * ## なぜ既定オフなのか
 *
 * このオプションは「録画品質を上げる」ものではなく、**リプレイを記録した際の
 * VsyncPatch設定を録画側へ伝えるための申告**である（`worker/docs/titles/th10.md`、
 * touhou-recorder reports/58）。記録時と異なる設定で再生するとリプレイずれ
 * （デシンク）が起きることを4パターン全てで実機確認済みで、リプレイファイル自体には
 * この設定情報が含まれないため録画側では自動判別できない。VsyncPatchのバグマリ修正は
 * 公式のものではなく利用者が能動的に導入する設定であり、大半の魔理沙Bリプレイは
 * 未修正（バグ挙動あり）のまま記録されていると見込まれるため、既定はオフ（パッチ
 * 無効=バグ挙動を再現）にする。バグマリ修正を有効にして記録した利用者だけが
 * チェックを入れる。
 *
 * ## なぜ「th10かつ魔理沙B」の組み合わせでしか選べないのか
 *
 * バグの発生条件（魔理沙Bのショット火力パワー3依存）そのものが対象を規定する。
 * 他キャラ・他タイトルではVsyncPatchの当該オプション自体が無意味なため、ページAは
 * 選ばれたリプレイの`game`/`character`がこの組み合わせでない限りグレーアウトする
 * （`apps/web/src/components/UploadForm.tsx`）。
 */

/** バグマリ修正オプションが意味を持つ唯一のタイトル。 */
export const TH10_BUGFIX_MARISA_B_GAME_ID: GameId = "th10";

/**
 * バグマリ修正オプションが意味を持つキャラクター識別子。
 * `@sattori/touhou-replay-parser`のth10デコーダが返す生の`character`値
 * （`packages/replay-parser/src/character-names.ts`のTH10テーブル参照）と一致させる。
 */
export const TH10_BUGFIX_MARISA_B_CHARACTER = "MarisaB";

/**
 * このリプレイ（タイトル・キャラクター）でバグマリ修正オプションが選べるか。
 * タイトル・キャラクターいずれか未確定（解析前）なら false。
 */
export function supportsTh10BugfixMarisaB(
  game: GameId | null,
  character: string | null,
): boolean {
  return game === TH10_BUGFIX_MARISA_B_GAME_ID && character === TH10_BUGFIX_MARISA_B_CHARACTER;
}
