/**
 * リプレイの読み取り中に発生した回復不能な問題（ファイル破損・不正なオフセット等）。
 * デコーダ内部でのみ throw され、parseReplay() の境界で必ず捕捉されて
 * ReplayParseError に変換される。呼び出し側にこの例外が漏れることはない。
 */
export class ReplayCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayCorruptError";
  }
}
