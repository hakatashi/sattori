import type { GameId } from "./games.js";

/**
 * GPU描画（Xorg+NVIDIA GRIDドライバ+DXVK）が録画に必須なタイトル一覧（Issue #241）。
 *
 * ## なぜGPUが必須なのか
 *
 * th06nc（東方紅魔郷: New Classic）はD3D11+DXライブラリで描画しており、既存9タイトルが
 * 使う Xvfb+wined3d+llvmpipe（ソフトウェア描画）の経路では720pで9.1fps、1080pで
 * 5.1fpsしか出ず、60fpsに遠く届かない（touhou-recorder reports/78）。
 * Xorg+NVIDIA GRIDドライバによるヘッドレス画面上でDXVK（D3D11→Vulkan）を使うことで
 * 60fps・重複フレーム率0.1〜0.4%を達成している（reports/79〜81）。
 *
 * ## 何に効くか
 *
 * - `apps/api/src/ec2.ts`: このリストに含まれるタイトルはGPU系Launch Template・
 *   GPU系ECRイメージ（`worker-gpu`）・`g6f.xlarge`系候補インスタンスタイプを使う。
 * - `apps/api/src/workerRouting.ts`: 自宅ワーカー（GPU非搭載）へは絶対にオファーしない
 *   （`GAME_ROUTING_POLICIES`の`offerToHomeWorker: false`）。
 * - `home-worker/src/config.ts`: 自宅ワーカーの既定`supportedGames`から除外する
 *   多層防御（本来は`workerRouting.ts`側の制御だけで十分だが、誤って自宅マシンに
 *   明示指定されることを防ぐ）。
 *
 * 将来th20等の既存CPU系タイトルをGPU化する場合はこの配列に足すだけでよい構造だが、
 * **今回はth06ncのみを対象とし、th20の録画経路は一切変更しない**（Issue #241の
 * スコープ外）。
 */
export const GPU_RECORDING_GAME_IDS: readonly GameId[] = ["th06nc"];

/** このタイトルの録画にGPU系インスタンスが必須か。 */
export function requiresGpuRecording(game: GameId): boolean {
  return GPU_RECORDING_GAME_IDS.includes(game);
}
