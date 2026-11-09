import type { GameId } from "./games.js";

/**
 * 録画速度（Issue #288、倍速録画）。**どの速度で録るかは録画の段（`recordingPlan.ts`）が決め、
 * ユーザーは選ばない**（Issue #317、`docs/decisions/0066`）。
 *
 * ゲームを内部的にN倍速で動かして録画し、後処理で等倍へ戻すことで、ユーザーの待ち時間と
 * インスタンス課金時間を減らす。技術検証は touhou-recorder reports/84〜90（g6f.2xlarge、
 * GPU描画＋NVENC）。2倍速は全タイトルで実用品質（録画時間は等倍の約52〜54%、等倍へ戻した後の
 * 落ちフレームは等倍と同等）。3倍速以上は x11grab のキャプチャが律速になり、落ちフレームが
 * 増える（3倍速で1〜3%、4倍速で7〜9%。th15は3倍速でも14%）。
 *
 * ## 仕組み（ワーカー側に分岐を作らない）
 *
 * 起動側（`apps/api/src/workerEnv.ts`）が `FPS_LIMIT_TARGET_HZ=60×N` を渡すだけで決まる。
 * ワーカーはこの値から倍率を導出し、MOD（QPC偽装・音声周波数スケール）・キャプチャの
 * フレームレート・監視のタイムアウト・変換（等倍への戻し）すべてへ一貫して適用する
 * （`worker/README.md` §5、`docs/decisions/0010`）。
 *
 * ## GPU必須
 *
 * **2倍速以上は必ずGPUの段で録画する**。CPU描画（Xvfb+llvmpipe）では2倍速を維持できない
 * （touhou-recorder reports/89）。
 *
 * ## 低速録画（Issue #316）
 *
 * GPUを確保できないタイトル（th15・th20）のCPUの段だけが使う（`docs/decisions/0064`）。
 */

/** 等倍・倍速録画の倍率。 */
export const RECORDING_SPEEDS = [1, 2, 3, 4] as const;

/** CPUの段の低速録画の倍率（30Hz・20Hz）。 */
export const SLOW_MOTION_RECORDING_SPEEDS = [1 / 2, 1 / 3] as const;

export type RecordingSpeed =
  | (typeof RECORDING_SPEEDS)[number]
  | (typeof SLOW_MOTION_RECORDING_SPEEDS)[number];

/** 等倍。`RecordingOptions.recordingSpeed` が無い（このフィールド導入前の）ジョブもこれとみなす。 */
export const NATIVE_RECORDING_SPEED: RecordingSpeed = 1;

/** ゲーム本来のフレームレート（Hz）。 */
export const NATIVE_GAME_FRAME_RATE_HZ = 60;

export function isRecordingSpeed(value: unknown): value is RecordingSpeed {
  return (
    typeof value === "number" &&
    ((RECORDING_SPEEDS as readonly number[]).includes(value) ||
      (SLOW_MOTION_RECORDING_SPEEDS as readonly number[]).includes(value))
  );
}

/** ジョブレコードの値を録画速度へ正規化する（低速を含む）。不正値は等倍。 */
export function normalizeRecordingSpeed(value: unknown): RecordingSpeed {
  return isRecordingSpeed(value) ? value : NATIVE_RECORDING_SPEED;
}

/** ジョブの録画オプションから録画速度を読む（欠損・不正値は等倍）。 */
export function recordingSpeedOf(options: { recordingSpeed?: unknown } | undefined): RecordingSpeed {
  return normalizeRecordingSpeed(options?.recordingSpeed);
}

/** 倍速録画（2倍速以上）か。 */
export function isSpeedupRecording(speed: RecordingSpeed): boolean {
  return speed > NATIVE_RECORDING_SPEED;
}

/** 低速録画（等倍未満）か。 */
export function isSlowMotionRecording(speed: RecordingSpeed): boolean {
  return speed < NATIVE_RECORDING_SPEED;
}

/** ワーカーへ渡す `FPS_LIMIT_TARGET_HZ`（60×倍率。1/3倍速の丸め誤差を落とすため整数へ丸める）。 */
export function recordingTargetHz(speed: RecordingSpeed): number {
  return Math.round(NATIVE_GAME_FRAME_RATE_HZ * speed);
}

/**
 * 倍速録画の実時間効率。録画の実時間は理想値（尺/N）よりわずかに長くなる
 * （ステージ間のロード等、実時間で進む区間があるため）。reports/89・90の実測で
 * 2倍速52〜54%、3倍速34.3%、4倍速26.1%（≒1.03〜1.08/N）。
 */
export const SPEEDUP_WALL_CLOCK_EFFICIENCY = 1.05;

/**
 * CPU低速録画の実時間効率。`c7i.4xlarge`の実測で1/2倍速が尺の×2.03〜2.08、1/3倍速が×3.09
 * （touhou-recorder reports/91）。
 */
export const SLOW_MOTION_WALL_CLOCK_EFFICIENCY = 1.03;

/**
 * 録画フェーズの実時間（秒）を、リプレイの尺（等倍の秒数）から見積もる。
 * 等倍ならそのまま、それ以外は `尺 × 効率 / 倍率`。
 */
export function recordingWallClockSeconds(contentSeconds: number, speed: RecordingSpeed): number {
  if (speed === NATIVE_RECORDING_SPEED) {
    return contentSeconds;
  }
  const efficiency = isSpeedupRecording(speed)
    ? SPEEDUP_WALL_CLOCK_EFFICIENCY
    : SLOW_MOTION_WALL_CLOCK_EFFICIENCY;
  return (contentSeconds * efficiency) / speed;
}

/**
 * 録画開始から完了までの所要時間の見積もりに使う係数。**実測に基づく概算**で、2026-08-30〜
 * 09-29の本番ジョブの課金時間（`launchedAt`→`doneAt`）を「固定オーバーヘッド＋尺×係数」で
 * 近似した値（Issue #288）。GPU系（g6f.2xlarge）とCPU系（c7i-flex.xlarge等・自宅ワーカー）で
 * 変換速度が違うため分けて持つ。倍速録画の係数は本番検証で見直すこと。
 */
export const COMPLETION_ESTIMATE = {
  gpu: {
    /** インスタンス起動・タイトル資産取得・ゲーム起動・アップロード等の固定分（秒）。 */
    overheadSeconds: 180,
    /** 配信用変換の所要時間（尺に対する比）。 */
    convertRatio: 0.08,
  },
  cpu: {
    overheadSeconds: 180,
    convertRatio: 0.22,
  },
} as const;

/**
 * 録画の開始から完了（ダウンロード可能になる）までの推定秒数。待ち行列での待ち時間は含まない。
 * UIの「推定時間」表示と、GPU待ち行列のETA（`gpuQueue.ts`）が共有する。
 */
export function estimateRecordingCompletionSeconds(
  contentSeconds: number,
  speed: RecordingSpeed,
  gpu: boolean,
): number {
  const profile = gpu ? COMPLETION_ESTIMATE.gpu : COMPLETION_ESTIMATE.cpu;
  return (
    profile.overheadSeconds +
    recordingWallClockSeconds(contentSeconds, speed) +
    contentSeconds * profile.convertRatio
  );
}
