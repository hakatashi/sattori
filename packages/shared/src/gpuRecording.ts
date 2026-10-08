import type { GameId } from "./games.js";
import { isSpeedupRecording, recordingSpeedOf } from "./recordingSpeed.js";

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
 *   GPU系ECRイメージ（`worker-gpu`）・GPU系候補インスタンスタイプ（g6f.2xlarge）を使う。
 *   倍速録画（Issue #288）のジョブも同じ経路を通る（`requiresGpuRecording()`）。
 * - `apps/api/src/workerRouting.ts`: 自宅ワーカー（GPU非搭載）へは絶対にオファーしない
 *   （`GAME_ROUTING_POLICIES`の`offerToHomeWorker: false`）。
 * - `home-worker/src/config.ts`: 自宅ワーカーの既定`supportedGames`から除外する
 *   多層防御（本来は`workerRouting.ts`側の制御だけで十分だが、誤って自宅マシンに
 *   明示指定されることを防ぐ）。
 *
 * th20（東方錦上京）は、Xvfb+llvmpipeでは高負荷区間（ボム・スペルカード）でゲーム自体が
 * 処理落ちする（reports/45・46）ため、GPU描画（g6f.2xlarge）の等倍録画へ移した
 * （Issue #288、`docs/decisions/0058`）。旧来の低速録画（1/2倍速）は廃止した。
 *
 * th15（東方紺珠伝、Issue #82）もこのリストに含まれる。ただしth06ncとは理由が
 * 異なる——th06ncはD3D11描画がXvfb+llvmpipeでは原理的に60fpsへ届かない
 * （GPUが無いと録画自体が成立しない）のに対し、th15はwined3d(D3D9→OpenGL)で
 * メニュー・大半のステージはソフトウェア描画でも60fps付近を維持できる。
 * Extraステージの高負荷演出区間でのみCPUコア数の追加では解消しない処理落ちが
 * 発生し、GPU（wined3d+OpenGL、DXVKではない）に切り替えることでこれが解消する
 * ことを実機検証で確認した（touhou-recorder reports/82）ため、品質を優先して
 * GPU系インスタンス（g6f系）に固定している。
 */
export const GPU_RECORDING_GAME_IDS: readonly GameId[] = ["th06nc", "th15", "th20"];

/** このタイトルは録画速度によらず常にGPU系インスタンスで録画するか。 */
export function isGpuOnlyTitle(game: GameId): boolean {
  return GPU_RECORDING_GAME_IDS.includes(game);
}

/**
 * このジョブの録画にGPU系インスタンス（g6f.2xlarge）が必須か。
 *
 * 常にGPUで録るタイトル（`GPU_RECORDING_GAME_IDS`）に加え、**倍速録画（2倍速以上、
 * Issue #288）は全タイトルGPU必須**（CPU描画では2倍速を維持できない。touhou-recorder
 * reports/89）。ここが true のジョブは自宅ワーカー（GPU非搭載）へは絶対にオファーせず、
 * GPU vCPU枠のリース（`docs/decisions/0056`）・GPU系Launch Template・`worker-gpu`イメージを使う。
 *
 * `options`を持たない旧レコードは等倍とみなす（`recordingSpeedOf()`）。
 */
export function requiresGpuRecording(job: {
  game: GameId;
  options?: { recordingSpeed?: unknown };
}): boolean {
  return isGpuOnlyTitle(job.game) || isSpeedupRecording(recordingSpeedOf(job.options));
}

/**
 * GPUを確保できなかった倍速録画ジョブを等倍（CPU）へフォールバックする理由（Issue #289）。
 *
 * - `gpu_queue_wait`: GPU vCPU枠の待ち行列で`SPEEDUP_FALLBACK_QUEUE_WAIT_MINUTES`以上待たされた
 *   （`handlers/sfn/acquireGpuSlot.ts`）。
 * - `gpu_capacity`: GPU枠は取れたが`CreateFleet`が容量不足で失敗し、それが
 *   `SPEEDUP_FALLBACK_CAPACITY_FAILURE_ATTEMPT`回目以降の試行だった
 *   （`handlers/sfn/handleFailure.ts`）。
 */
export const SPEEDUP_FALLBACK_REASONS = ["gpu_queue_wait", "gpu_capacity"] as const;
export type SpeedupFallbackReason = (typeof SPEEDUP_FALLBACK_REASONS)[number];

/**
 * GPU待ち行列でこの分数以上待った倍速録画ジョブは等倍へフォールバックする（Issue #289）。
 * 待ち行列そのもののタイムアウト（`GPU_QUEUE_MAX_WAIT_MINUTES`、120分）より十分短くする——
 * 倍速録画を選ぶ動機は「早く仕上がること」なので、30分待ってなお枠が空かないなら、
 * 等倍でもすぐ録り始めたほうが早く仕上がる見込みが高い。
 */
export const SPEEDUP_FALLBACK_QUEUE_WAIT_MINUTES = 30;

/**
 * GPU経路の起動試行が容量不足（`UnfulfillableCapacity`等）で失敗したとき、それが
 * この回数目以降の試行なら等倍へフォールバックする（Issue #289）。1試行あたり
 * `WaitBeforeCheck`の3分を挟むため、3なら最初の起動から約6〜9分で見切ることになる
 * （`MAX_ATTEMPTS`=10回≒27分を待ってから`capacity_exhausted`で失敗させるより早い）。
 */
export const SPEEDUP_FALLBACK_CAPACITY_FAILURE_ATTEMPT = 3;

/**
 * GPUを確保できないときに等倍（CPU）へフォールバックできるジョブか（Issue #289）。
 *
 * 倍速録画（2倍速以上）で、かつ録画速度によらずGPUで録るタイトル（`GPU_RECORDING_GAME_IDS`）
 * でないもの。th06nc・th15・th20は等倍でもGPUが要るので、落とす先が無い。
 * 一度フォールバックしたジョブは`options.recordingSpeed`が1になるので、二度目は無い。
 */
export function canFallBackToNativeSpeed(job: {
  game: GameId;
  options?: { recordingSpeed?: unknown };
}): boolean {
  return !isGpuOnlyTitle(job.game) && isSpeedupRecording(recordingSpeedOf(job.options));
}
