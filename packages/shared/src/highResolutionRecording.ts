import type { GameId } from "./games.js";

/**
 * 1080p録画オプション（Issue #241）に関する定数と判定。
 *
 * ## 何のオプションか
 *
 * th06nc（東方紅魔郷: New Classic）はウィンドウ解像度を720p/1080pから選べる
 * （`th06.env`のbyte[5]で切り替え、touhou-recorder reports/78 §4.1）。既定は720pだが、
 * ユーザーが希望すれば1080pで録画できるようにする。
 *
 * ## なぜ th06nc 限定なのか
 *
 * 解像度選択自体がタイトル固有の仕様（`th06.env`のバイナリフォーマット、Xorg+nvidia
 * 環境でのCRTCモード切り替え、`worker/recording/gpu_display.py`）に依存しており、
 * 対応タイトルはGPU描画必須タイトル（`GPU_RECORDING_GAME_IDS`）の中でも実装・実機検証を
 * 済ませたものだけに限られる。
 *
 * ## 既知の品質トレードオフ
 *
 * 1080p録画はtouhou-recorder reports/81 §9.9.3の実測では本来g6f.2xlarge（8vCPU）が
 * 推奨——4vCPUでは実効fpsが54.87まで悪化し重複フレーム率が7.9%まで増える——だが、
 * 1080pもg6f.xlarge（4vCPU）で起動しうる（`docs/decisions/0046-gpu-ec2-instance-and-fixed-ami.md`）。
 * 当時のeu-south-2のG系スポットクォータ（8vCPU）で並列録画の余地を残すためのユーザー
 * 判断だった。クォータは32vCPUに引き上げられたため、1080pをg6f.2xlargeに固定する
 * 見直しをIssue #286で検討している。1080p録画で処理落ちが疑われる場合はこの制約を
 * 踏まえて調査すること（`docs/known-limitations.md`）。
 */
export const HIGH_RESOLUTION_RECORDING_SUPPORTED_GAME_IDS: readonly GameId[] = ["th06nc"];

/** このリプレイ（タイトル）で1080p録画オプションが選べるか。タイトル未確定なら false。 */
export function supportsHighResolutionRecording(game: GameId | null): boolean {
  return game !== null && HIGH_RESOLUTION_RECORDING_SUPPORTED_GAME_IDS.includes(game);
}
