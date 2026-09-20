/**
 * GPU録画ジョブのvCPU容量リース・待ち行列に関する定数と純粋関数（Issue #270）。
 * フロントエンド・API・インフラ(CDK)の3者が同じ値を参照する。
 *
 * ## なぜ要るのか
 *
 * eu-south-2 の G系スポットインスタンスのvCPUクオータは現状 **8vCPU** しかない
 * （32vCPUへの引き上げ申請は進行中だがAWSサポートから1週間以上応答が無く、望みは
 * 薄い）。GPU描画必須タイトル（`GPU_RECORDING_GAME_IDS`、`gpuRecording.ts`）は
 * `g6f.xlarge`(4vCPU) / `g6f.2xlarge`(8vCPU) で起動するため、同時に走れるのは実質
 * 1〜2本のみ。この定数モジュールと `apps/api/src/gpuSlots.ts`（DynamoDBでの
 * vCPU会計）・`apps/api/src/gpuQueue.ts`（順位・ETA計算）が、このクオータの範囲内で
 * ジョブを正しく並べて待たせる仕組みの土台になる。詳細な設計は
 * `docs/decisions/0056-gpu-vcpu-lease-and-queue.md` を参照。
 *
 * ## 設定値をコード内定数にする理由
 *
 * `docs/decisions/0045-ec2-slow-motion-for-th20.md` と同じ流儀——ランタイムの外部
 * ストア（SSM/DynamoDB設定）を導入するとキャッシュ整合性・IAM権限・インフラ管理
 * コストが増える一方、この値は型検査とユニットテストで十分に安全に扱える。クオータの
 * 引き上げが実際に通った場合は `GPU_VCPU_QUOTA` をここで書き換えてデプロイするだけでよい。
 */

/** eu-south-2 の G系スポットインスタンスのvCPUクオータ。 */
export const GPU_VCPU_QUOTA = 8;

/** GPU候補インスタンスタイプ（`apps/api/src/ec2.ts` の `GPU_CANDIDATE_INSTANCE_TYPES`
 *  と対で使う）ごとのvCPU数。 */
export const GPU_INSTANCE_TYPE_VCPUS: Readonly<Record<string, number>> = {
  "g6f.xlarge": 4,
  "g6f.2xlarge": 8,
};

/** GPU候補インスタンスタイプのうち最小のvCPU数。空き容量がこれ未満なら誰も起動できない。 */
export const GPU_MIN_INSTANCE_VCPU = Math.min(...Object.values(GPU_INSTANCE_TYPE_VCPUS));

/** GPU候補インスタンスタイプのうち最大のvCPU数。 */
export const GPU_MAX_INSTANCE_VCPU = Math.max(...Object.values(GPU_INSTANCE_TYPE_VCPUS));

/**
 * リースの有効期限（分）。`Launch` タスクの `taskTimeout`（150分）+ 余裕30分。
 * 取りこぼしたリースが枠を無期限に塞ぎ続けないための保険で、正常系では
 * `ReleaseGpuSlot`（成功時）・`HandleFailure`（失敗時）が先に明示的に返却する。
 */
export const GPU_LEASE_ACTIVE_MINUTES = 180;

/**
 * 録画そのものの所要時間（`estimatedDurationSeconds`）に加算する、起動・変換・
 * アップロード・通知のオーバーヘッド見積もり（秒）。ETA計算の保守側マージン。
 */
export const GPU_JOB_OVERHEAD_SECONDS = 5 * 60;

/**
 * `estimatedDurationSeconds` が null（リプレイのframeCountが読めなかった等）の
 * ジョブのETA計算に使うフォールバック値（秒）。`jobProgressBudget.ts` の
 * `FALLBACK_ESTIMATED_DURATION_SECONDS` と同じ考え方。
 */
export const GPU_QUEUE_FALLBACK_DURATION_SECONDS = 10 * 60;

/**
 * 待ち行列に入ってからの最大待機時間（分）。これを超えたら `gpu_queue_timeout` で
 * 失敗を確定させる。`gpuQueueEnteredAt`（待機エピソードの起点）からの経過で判定する
 * ——`gpuQueuedAt`（FIFO順の基準）ではないことに注意。理由は
 * `docs/decisions/0056-gpu-vcpu-lease-and-queue.md` 参照。
 */
export const GPU_QUEUE_MAX_WAIT_MINUTES = 120;

/**
 * 待機列の先頭判定・順位計算から除外する、心拍（`gpuQueueHeartbeatAt`）の陳腐化
 * しきい値（秒）。`GPU_QUEUE_POLL_MAX_SECONDS` の4倍——生きている待機者は必ずこの
 * 間隔以内に心拍を打つので、これより古い項目は取り残された死んだ待機者とみなせる
 * （head-of-line blocking対策）。
 */
export const GPU_QUEUE_STALE_AFTER_SECONDS = 480;

/** 待機開始からの経過（秒）に応じたポーリング間隔の閾値。 */
export const GPU_QUEUE_POLL_RAMP_1_SECONDS = 15;
export const GPU_QUEUE_POLL_RAMP_2_SECONDS = 30;
export const GPU_QUEUE_POLL_MAX_SECONDS = 120;
const GPU_QUEUE_POLL_RAMP_1_THRESHOLD_SECONDS = 2 * 60;
const GPU_QUEUE_POLL_RAMP_2_THRESHOLD_SECONDS = 10 * 60;

/** `JobsTable` 上でGPU待ち行列を表す sparse GSI の名前。 */
export const GPU_QUEUE_INDEX = "GpuQueueIndex";

/** `gpuQueueState` が取りうる唯一の値。 */
export const GPU_QUEUE_WAITING = "waiting";

/** そのインスタンスタイプのvCPU数。候補外のタイプが渡されたら null。 */
export function vcpusForInstanceType(instanceType: string): number | null {
  return GPU_INSTANCE_TYPE_VCPUS[instanceType] ?? null;
}

/**
 * 空きvCPU（`GPU_VCPU_QUOTA - usedVcpu`）から、確保を試みるvCPU量を決める。
 * 8vCPU分の空きがあれば大きい方（両候補タイプが使える）、4vCPU分しか無ければ
 * 小さい方（`g6f.xlarge`のみ）、それ未満なら確保不可（null）。
 *
 * `minVcpu` を指定すると要求下限を引き上げられる（リトライ時＝`attempt > 1` に
 * 4vCPUでの投機的確保をやめ、クオータ全量8vCPUの空きを待つために使う）。
 *
 * これはあくまで「どちらのタイプで試すか」の事前判断であり、実際の安全性は
 * `apps/api/src/gpuSlots.ts` の `TransactWriteItems` の `ConditionExpression` が
 * 保証する（この関数の呼び出しと実際の書き込みの間に競合が起きても、条件式が
 * 弾くので過剰確保は起きない）。
 */
export function reservableVcpu(
  availableVcpu: number,
  minVcpu: number = GPU_MIN_INSTANCE_VCPU,
): number | null {
  if (availableVcpu < minVcpu) {
    return null;
  }
  if (availableVcpu >= GPU_MAX_INSTANCE_VCPU) {
    return GPU_MAX_INSTANCE_VCPU;
  }
  if (availableVcpu >= GPU_MIN_INSTANCE_VCPU) {
    return GPU_MIN_INSTANCE_VCPU;
  }
  return null;
}

/**
 * 待機開始（`gpuQueueEnteredAt`）からの経過秒数に応じて、次にAcquireGpuSlotを
 * 呼び直すまでの待機秒数を決める。固定間隔にすると120分待機でStep Functions
 * Standard実行の履歴イベント上限（25,000件、1周あたり約9イベント）に接近しうるため、
 * 経過に応じて間伸びさせる（`gpuQueue.test.ts` で上限内に収まることを検証する）。
 */
export function nextPollIntervalSeconds(elapsedSeconds: number): number {
  if (elapsedSeconds < GPU_QUEUE_POLL_RAMP_1_THRESHOLD_SECONDS) {
    return GPU_QUEUE_POLL_RAMP_1_SECONDS;
  }
  if (elapsedSeconds < GPU_QUEUE_POLL_RAMP_2_THRESHOLD_SECONDS) {
    return GPU_QUEUE_POLL_RAMP_2_SECONDS;
  }
  return GPU_QUEUE_POLL_MAX_SECONDS;
}

/** 待機エピソードが上限（`GPU_QUEUE_MAX_WAIT_MINUTES`）を超えたか。 */
export function isQueueWaitTimedOut(elapsedSeconds: number): boolean {
  return elapsedSeconds >= GPU_QUEUE_MAX_WAIT_MINUTES * 60;
}

/** 心拍が陳腐化していて先頭判定・順位計算から除外すべきか。 */
export function isHeartbeatStale(heartbeatAgeSeconds: number): boolean {
  return heartbeatAgeSeconds > GPU_QUEUE_STALE_AFTER_SECONDS;
}

export interface QueueAheadJob {
  /** `estimatedDurationSeconds`。null ならフォールバック値を使う。 */
  estimatedDurationSeconds: number | null;
}

export interface ActiveLease {
  /** リースが空くと見込まれる時刻（エポックミリ秒）。 */
  expectedFinishAtMs: number;
}

/**
 * 待ち行列でのETA（推定待ち秒数）を計算する。前方の待機ジョブ（stale除外済み）の
 * 所要時間合計に、最も早く空く実行中リースの残り時間を加える——**保守的に並列1で
 * 直列に見積もる**（並列2を仮定して短く出すと外したときの失望が大きい）。
 *
 * 実行中リースが無い（＝今すぐ空きがある）場合は前方ジョブの所要時間合計のみを返す。
 */
export function estimateQueueWaitSeconds(
  aheadJobs: readonly QueueAheadJob[],
  activeLeases: readonly ActiveLease[],
  nowMs: number,
): number {
  const aheadSeconds = aheadJobs.reduce(
    (sum, job) =>
      sum +
      (job.estimatedDurationSeconds ?? GPU_QUEUE_FALLBACK_DURATION_SECONDS) +
      GPU_JOB_OVERHEAD_SECONDS,
    0,
  );
  if (activeLeases.length === 0) {
    return aheadSeconds;
  }
  const earliestFinishMs = Math.min(...activeLeases.map((lease) => lease.expectedFinishAtMs));
  const remainingSeconds = Math.max(0, Math.round((earliestFinishMs - nowMs) / 1000));
  return remainingSeconds + aheadSeconds;
}
