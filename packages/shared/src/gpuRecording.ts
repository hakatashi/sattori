import type { GameId } from "./games.js";
import {
  isSlowMotionRecording,
  isSpeedupRecording,
  NATIVE_RECORDING_SPEED,
  recordingSpeedOf,
} from "./recordingSpeed.js";
import type { RecordingSpeed } from "./recordingSpeed.js";

/**
 * 等倍以上の録画にGPU描画（Xorg+NVIDIA GRIDドライバ+DXVK）が要るタイトル一覧（Issue #241）。
 * このうちth15・th20はGPUを確保できなければCPU低速録画へ落とせる（Issue #316、
 * `SLOW_MOTION_FALLBACK_GAME_IDS`）ので、**落とす先が無いのはth06ncだけ**である。
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

/** このタイトルは等倍以上なら常にGPU系インスタンスで録画するか（低速録画だけがCPU系）。 */
export function isGpuOnlyTitle(game: GameId): boolean {
  return GPU_RECORDING_GAME_IDS.includes(game);
}

/**
 * GPUを確保できないときにCPU低速録画へ落とせるタイトル（Issue #316）。`c7i.4xlarge`の
 * 1/2倍速・1/3倍速で実機検証し、ユーザーが視聴して採用した（touhou-recorder reports/91）。
 */
export const SLOW_MOTION_FALLBACK_GAME_IDS: readonly GameId[] = ["th15", "th20"];

/**
 * th15のExtraは1/2倍速でも高負荷区間で30Hzを維持できない（最低19.8Hz、BGMが映像より先行する）
 * ため1/3倍速で録る（reports/91）。`replayInfo`が読めないジョブは1/2倍速。
 */
function slowMotionSpeedFor(job: {
  game: GameId;
  replayInfo?: { difficulty: string | null } | null;
}): RecordingSpeed {
  return job.game === "th15" && job.replayInfo?.difficulty === "Extra" ? 1 / 3 : 1 / 2;
}

/**
 * このジョブの録画にGPU系インスタンス（g6f.2xlarge）が必須か。
 *
 * 常にGPUで録るタイトル（`GPU_RECORDING_GAME_IDS`）に加え、**倍速録画（2倍速以上、
 * Issue #288）は全タイトルGPU必須**（CPU描画では2倍速を維持できない。touhou-recorder
 * reports/89）。ここが true のジョブは自宅ワーカー（GPU非搭載）へは絶対にオファーせず、
 * GPU vCPU枠のリース（`docs/decisions/0056`）・GPU系Launch Template・`worker-gpu`イメージを使う。
 *
 * 低速録画（Issue #316）はGPUを確保できなかったジョブなので false。
 *
 * `options`を持たない旧レコードは等倍とみなす（`recordingSpeedOf()`）。
 */
export function requiresGpuRecording(job: {
  game: GameId;
  options?: { recordingSpeed?: unknown };
}): boolean {
  const speed = recordingSpeedOf(job.options);
  if (isSlowMotionRecording(speed)) {
    return false;
  }
  return isGpuOnlyTitle(job.game) || isSpeedupRecording(speed);
}

/**
 * GPUを確保できなかったジョブの録画速度を落とす理由（Issue #289・#316）。
 *
 * - `gpu_queue_wait`: GPU vCPU枠の待ち行列で`SPEEDUP_FALLBACK_QUEUE_WAIT_MINUTES`以上待たされた
 *   （`handlers/sfn/acquireGpuSlot.ts`）。
 * - `gpu_capacity`: GPU枠は取れたが起動できなかった。全リージョンのSpot在庫の枯渇
 *   （`handlers/sfn/launch.ts`、Issue #315）か、クォータ超過などが
 *   `SPEEDUP_FALLBACK_QUOTA_FAILURE_ATTEMPT`回目以降の試行まで続いた場合
 *   （`handlers/sfn/handleFailure.ts`）。
 */
export const SPEEDUP_FALLBACK_REASONS = ["gpu_queue_wait", "gpu_capacity"] as const;
export type SpeedupFallbackReason = (typeof SPEEDUP_FALLBACK_REASONS)[number];

/**
 * GPU待ち行列でこの分数以上待ったジョブは、落とせる速度があれば落とす（Issue #289・#316）。
 * 待ち行列そのもののタイムアウト（`GPU_QUEUE_MAX_WAIT_MINUTES`、120分）より十分短くする——
 * 倍速録画を選ぶ動機は「早く仕上がること」なので、30分待ってなお枠が空かないなら、
 * 等倍でもすぐ録り始めたほうが早く仕上がる見込みが高い。
 */
export const SPEEDUP_FALLBACK_QUEUE_WAIT_MINUTES = 30;

/**
 * GPU経路の起動試行がクォータ超過（`VcpuLimitExceeded`等）などで失敗したとき、それが
 * この回数目以降の試行なら速度を落とす（Issue #289・#316）。1試行あたり
 * `WaitBeforeCheck`の3分を挟むため、3なら最初の起動から約6〜9分で見切ることになる。
 * Spot在庫の枯渇は待たずにフォールバックするので、この定数は使わない（Issue #315）。
 */
export const SPEEDUP_FALLBACK_QUOTA_FAILURE_ATTEMPT = 3;

/**
 * GPUを確保できないジョブをCPUで録るための録画速度（Issue #289・#316）。落とせなければ null。
 *
 * - th15・th20（`SLOW_MOTION_FALLBACK_GAME_IDS`）: 倍速でも等倍でも低速録画へ落とす。
 *   CPU等倍は`c7i.4xlarge`でも落ち3.4〜6.8%で実用にならない（touhou-recorder reports/91）。
 * - それ以外の倍速録画: 等倍へ落とす。
 * - th06nc: 落とす先が無い（代わりに`g6.2xlarge`の段がある、`apps/api/src/ec2.ts`）。
 *
 * 一度落としたジョブはGPUジョブではなくなるので、二度目は無い。
 */
export function fallbackRecordingSpeedFor(job: {
  game: GameId;
  options?: { recordingSpeed?: unknown };
  replayInfo?: { difficulty: string | null } | null;
}): RecordingSpeed | null {
  if (!requiresGpuRecording(job)) {
    return null;
  }
  if (SLOW_MOTION_FALLBACK_GAME_IDS.includes(job.game)) {
    return slowMotionSpeedFor(job);
  }
  return isGpuOnlyTitle(job.game) ? null : NATIVE_RECORDING_SPEED;
}
