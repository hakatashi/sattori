import type { ReplayGameId } from "./game-ids.js";

/**
 * ステージ（面）ごとの記録。ゲームによって記録される項目が異なるため、
 * 該当データを含まないゲームでは各フィールドが null になる。
 */
export interface ReplayStageSplit {
  /**
   * ステージ番号（判別できない場合は null）。多くのゲームでは
   * 「そのステージを開始した時点」のスナップショットとして記録されるため、
   * score 等は実質的に「1つ前のステージ終了時点」の値になる点に注意
   * （原作リプレイ選択画面の "Stage N" 行が示す値と対応する）。
   */
  stage: number | null;
  /** このスナップショット時点のスコア。 */
  score: number | null;
  /** パワー（表記はゲームごとに異なるため文字列。例: "1.00", "128"）。 */
  power: string | null;
  /** PIV（Point of Item Value）等、ゲーム固有の得点指標。 */
  piv: number | null;
  /** 残機（ゲームによっては欠片数を含む文字列）。 */
  lives: string | null;
  /** ボム数（ゲームによっては欠片数を含む文字列）。 */
  bombs: string | null;
  /** グレイズ数。 */
  graze: number | null;
  /** UFO の色・トランス・季節等、ゲーム固有の付加情報。 */
  additional: string | null;
}

/**
 * `.rpy` ファイルから抽出できる情報の全体。`packages/shared` の
 * `ReplayInfo` はこの型のサブセット（Sattori の録画メタデータ表示に
 * 必要な項目のみ）に対応する。
 */
export interface ParsedReplay {
  game: ReplayGameId;
  gameTitle: string;
  /**
   * ヘッダから読み取れる生のフォーマット/バージョンバイト（ゲームごとに
   * 意味・オフセットが異なる）。互換性のないゲーム本体バージョンで録画された
   * リプレイを判別する手がかりとして利用できる（Sattori では #16 の
   * 検知に使用）。判定できないゲームでは null。
   */
  formatVersion: number | null;
  player: string | null;
  /** 記録日時。元データの表記をそのまま保持する（例: "25/12/31"）。 */
  date: string | null;
  character: string | null;
  difficulty: string | null;
  /** 到達／記録ステージ・シーンの表記（例: "Stage 6", "Extra"）。 */
  stage: string | null;
  score: number | null;
  /**
   * 全面クリア（Player Wins に相当する状態）を検出できた場合のみ true/false。
   * 判定材料がないゲーム・リプレイ種別では null。
   */
  cleared: boolean | null;
  /** ステージごとの記録（判別できないゲームでは空配列）。 */
  splits: ReplayStageSplit[];
}

export type ReplayParseErrorCode =
  /** ファイルが短すぎてマジックバイトすら読めない。 */
  | "too_short"
  /** 先頭4バイトが既知のどの東方リプレイマジックとも一致しない。 */
  | "unknown_magic"
  /** マジックは既知だが、このパッケージがまだデコーダを実装していない。 */
  | "unsupported_game"
  /** マジックは既知の形式だが、以降のデータが不正で安全に読み進められない。 */
  | "corrupt";

export interface ReplayParseError {
  code: ReplayParseErrorCode;
  message: string;
  /** unsupported_game / corrupt の場合、マジックから判定できたゲームID。 */
  game?: ReplayGameId;
}

export type ReplayParseResult = { ok: true; replay: ParsedReplay } | { ok: false; error: ReplayParseError };

/** 固定長フィールドのパディング空白を取り除く。空文字列は null として扱う。 */
export function normalizeText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function emptySplit(): ReplayStageSplit {
  return {
    stage: null,
    score: null,
    power: null,
    piv: null,
    lives: null,
    bombs: null,
    graze: null,
    additional: null,
  };
}
