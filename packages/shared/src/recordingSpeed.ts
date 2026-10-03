import type { GameId } from "./games.js";

/**
 * 録画速度（Issue #288、倍速録画）。
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
 * **2倍速以上は必ずGPUインスタンス（g6f.2xlarge）で録画する**。CPU描画（Xvfb+llvmpipe）では
 * 2倍速を維持できず、自宅ワーカーはGPUを持たない（`gpuRecording.ts`の`requiresGpuRecording()`）。
 */

/** 選べる録画速度（倍率）。 */
export const RECORDING_SPEEDS = [1, 2, 3, 4] as const;
export type RecordingSpeed = (typeof RECORDING_SPEEDS)[number];

/** 等倍。`RecordingOptions.recordingSpeed` が無い（このフィールド導入前の）ジョブもこれとみなす。 */
export const NATIVE_RECORDING_SPEED: RecordingSpeed = 1;

/** ゲーム本来のフレームレート（Hz）。 */
export const NATIVE_GAME_FRAME_RATE_HZ = 60;

export function isRecordingSpeed(value: unknown): value is RecordingSpeed {
  return typeof value === "number" && (RECORDING_SPEEDS as readonly number[]).includes(value);
}

/** 未知の値（APIの入力・旧レコード）を録画速度へ正規化する。不正値は等倍。 */
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

/** 倍速録画でワーカーへ渡す `FPS_LIMIT_TARGET_HZ`（60×倍率）。 */
export function speedupTargetHz(speed: RecordingSpeed): number {
  return NATIVE_GAME_FRAME_RATE_HZ * speed;
}

/**
 * タイトルごとの「おすすめ」録画速度。事前の品質チェックで問題が無いと認められた速度で、
 * リプレイ選択後の既定値になる（ユーザーはこれより速い速度も選べるが、警告を出す）。
 *
 * th06ncは解像度で変わる（`recommendedRecordingSpeed()`）。1080pは描画・キャプチャとも
 * 720pの2.25倍の画素数で、倍速録画を検証していないため等倍を推奨する。
 * th20は2倍速ではゲーム本体の単一スレッド性能が足りず落ちフレームが等倍の16倍に増える
 * （reports/89）ため等倍を推奨する。
 */
export const RECOMMENDED_RECORDING_SPEED: Readonly<Record<GameId, RecordingSpeed>> = {
  th06: 2,
  th06c: 2,
  th06nc: 2,
  th07: 3,
  th08: 2,
  th09: 2,
  th10: 2,
  th11: 2,
  th12: 2,
  th128: 2,
  th15: 2,
  th20: 1,
  // 以下は録画非対応タイトル（`SUPPORTED_GAME_IDS`外）。録画ジョブは作られないが、
  // 型の網羅性のため等倍を置く。
  th095: 1,
  th125: 1,
  th13: 1,
  th14: 1,
  th143: 1,
  th16: 1,
  th165: 1,
  th17: 1,
  th18: 1,
};

/** 1080p録画時のth06ncのおすすめ速度。 */
export const TH06NC_HIGH_RESOLUTION_RECOMMENDED_SPEED: RecordingSpeed = 1;

/** リプレイ（タイトルと録画オプション）に対するおすすめ速度。 */
export function recommendedRecordingSpeed(
  game: GameId,
  options: { th06ncHighResolution?: boolean } = {},
): RecordingSpeed {
  if (game === "th06nc" && options.th06ncHighResolution) {
    return TH06NC_HIGH_RESOLUTION_RECOMMENDED_SPEED;
  }
  return RECOMMENDED_RECORDING_SPEED[game];
}

/** 選ばれた速度がおすすめより速いか（UIで警告を出す条件）。 */
export function isFasterThanRecommended(
  game: GameId,
  speed: RecordingSpeed,
  options: { th06ncHighResolution?: boolean } = {},
): boolean {
  return speed > recommendedRecordingSpeed(game, options);
}

/**
 * 倍速録画の実時間効率。録画の実時間は理想値（尺/N）よりわずかに長くなる
 * （ステージ間のロード等、実時間で進む区間があるため）。reports/89・90の実測で
 * 2倍速52〜54%、3倍速34.3%、4倍速26.1%（≒1.03〜1.08/N）。
 */
export const SPEEDUP_WALL_CLOCK_EFFICIENCY = 1.05;

/**
 * 録画フェーズの実時間（秒）を、リプレイの尺（等倍の秒数）から見積もる。
 * 等倍ならそのまま、倍速なら `尺 × SPEEDUP_WALL_CLOCK_EFFICIENCY / N`。
 */
export function recordingWallClockSeconds(contentSeconds: number, speed: RecordingSpeed): number {
  if (!isSpeedupRecording(speed)) {
    return contentSeconds;
  }
  return (contentSeconds * SPEEDUP_WALL_CLOCK_EFFICIENCY) / speed;
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
