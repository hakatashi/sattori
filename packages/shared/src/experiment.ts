import type { GameId } from "./games.js";
import type { RecordingStep } from "./recordingPlan.js";
import type { RecordingSpeed } from "./recordingSpeed.js";

/**
 * 実験ジョブ（Epic #399、Issue #397、`docs/decisions/0075`）の指定。管理APIが段を明示して録画ジョブを
 * 投げるためのもので、`JobRecord.experiment`に入る。このフィールドがあるジョブは、タイトルの録画の段
 * （`RECORDING_PLANS`）の代わりに`step`だけを1段の計画として使う（`recordingPlanOf()`）。
 * ほかは通常のジョブと同じStep Functions・孤児掃除・コスト推定・ログに乗る。
 */
export interface ExperimentSpec {
  /** 試す段。使い切ったら（Spot在庫の枯渇など）ほかの段へは落ちず`capacity_exhausted`で失敗する。 */
  step: RecordingStep;
  /**
   * 検証用ECRリポジトリ（`sattori-worker-experimental`／`-gpu`）のイメージタグ。省略時は本番のイメージ
   * （`:latest`）。指定した場合、EC2の一次リージョンの段でだけ使える（自宅ワーカーとGPUのフォールバック先
   * リージョンには検証用イメージが届かない）。
   */
  workerImageTag?: string;
  /** 何を検証するジョブか（管理画面・結果の一覧で見るための自由記述）。 */
  note?: string;
}

/** 実験ジョブの段の指定（`POST /admin/experiments`）。 */
export type AdminExperimentStepRequest =
  | { kind: "home"; captureMode: "realtime"; speed: RecordingSpeed }
  | { kind: "home"; captureMode: "frameSync"; speed?: 1 }
  | {
      kind: "ec2";
      platform: "cpu" | "gpu";
      region: string;
      /** 候補のインスタンスタイプ（1回の`CreateFleet`に渡す）。 */
      instanceTypes: string[];
      captureMode: "realtime";
      speed: RecordingSpeed;
    }
  | {
      kind: "ec2";
      platform: "cpu" | "gpu";
      region: string;
      instanceTypes: string[];
      captureMode: "frameSync";
      speed?: 1;
    };

/** POST /admin/experiments のリクエスト。 */
export interface AdminCreateExperimentRequest {
  /**
   * 録画するリプレイ。次のどちらかを指定する。
   * - `sourceJobId`: 既存ジョブのリプレイ・タイトル・解析結果を使う。
   * - `replayKey`＋`game`: アップロード用バケットのキー（`POST /uploads`で上げたもの）。
   */
  sourceJobId?: string;
  replayKey?: string;
  game?: GameId;
  step: AdminExperimentStepRequest;
  workerImageTag?: string;
  note?: string;
  /** 録画オプション（`watermark`・`th10BugfixMarisaB`のみ。省略時は既定値）。 */
  options?: { watermark?: boolean; th10BugfixMarisaB?: boolean };
}

/** POST /admin/experiments のレスポンス。 */
export interface AdminCreateExperimentResponse {
  jobId: string;
  status: "queued";
  stepId: string;
}

/**
 * 実験ジョブの結果（`GET /admin/experiments`の1件）。検証レポート用に、ジョブレコードと推定コストから
 * 品質・速度・課金時間をまとめる。**品質の判定値は`desyncDetected`・`timedOut`だけ**で、重複フレーム率などの
 * 録画ごとの詳細はワーカーのログ（`GET /admin/jobs/{jobId}/logs`）にある。
 */
export interface AdminExperimentResult {
  jobId: string;
  game: GameId;
  status: string;
  createdAt: string;
  note: string | null;
  workerImageTag: string | null;
  stepId: string;
  captureMode: string;
  speed: RecordingSpeed;
  workerKind: string | null;
  instanceType: string | null;
  availabilityZone: string | null;
  workerRegion: string | null;
  /** リプレイの推定尺（秒）。 */
  estimatedDurationSeconds: number | null;
  /** `launchedAt`から終了（`doneAt`、無ければ`updatedAt`）までの実時間（秒）。試行間の待機を含み、わずかに過大。 */
  wallClockSeconds: number | null;
  /** `wallClockSeconds / estimatedDurationSeconds`。1.0なら尺と同じ時間で録れた（小さいほど速い）。 */
  wallClockToDurationRatio: number | null;
  desyncDetected: boolean | null;
  timedOut: boolean | null;
  error: string | null;
  errorCode: string | null;
  /** 推定コスト（USD。請求額ではない、`cost.ts`）。 */
  estimatedCostUsd: number;
  /** 課金対象時間（秒）の推定。EC2以外は0。 */
  billedSeconds: number;
}

/** GET /admin/experiments のレスポンス。 */
export interface AdminExperimentListResponse {
  items: AdminExperimentResult[];
}
