/**
 * Lambda 実行時の環境変数から設定を読み込む。CDK 側（infra/）でこれらを注入する。
 */
export interface ApiConfig {
  /** アップロードされた .rpy を置く一時バケット。 */
  uploadBucket: string;
  /** 録画済み動画の出力バケット（CloudFront オリジン）。 */
  outputBucket: string;
  /** CloudFront 配信ドメイン（例: dxxxx.cloudfront.net）。 */
  cdnDomain: string;
  /** ジョブ状態を保持する DynamoDB テーブル名。 */
  jobsTable: string;
  /** 録画ワーカーの ECR イメージ URI。 */
  workerImage: string;
  /** ワーカーコンテナのログを送出する CloudWatch Logs ロググループ名。 */
  logGroup: string;
  /** 録画 EC2 の起動パラメータ。 */
  ec2: Ec2LaunchConfig;
  /** アップロード可能な .rpy の最大サイズ（バイト）。 */
  maxReplayBytes: number;
  /** メール送信のレート制限カウンタを保持する DynamoDB テーブル名。 */
  emailRateLimitTable: string;
  /** マジックリンクメールの送信元アドレス（SESで検証済みのドメイン配下）。 */
  sesFromAddress: string;
  /** マジックリンクURLを組み立てる際のWebフロントエンドのベースURL（末尾スラッシュなし）。 */
  webBaseUrl: string;
}

export interface Ec2LaunchConfig {
  /** 起動先サブネット（複数AZ）。EC2 Fleet の Overrides に列挙し、AZ分散でSpot中断耐性を上げる。 */
  subnetIds: string[];
  /** AWS リージョン。 */
  region: string;
  /**
   * ベースとなる EC2 Launch Template ID。AMI/インスタンスタイプ/IAMロール/SGは
   * CDK側でこのLaunch Templateに設定済み。ジョブ起動時は
   * `CreateLaunchTemplateVersion` でジョブ固有の UserData のみを持つバージョンを
   * 作成し、`CreateFleet` からそのバージョンを参照する。
   */
  launchTemplateId: string;
}

/**
 * 必須の環境変数を読む。`loadConfig()` の内部専用ではなく `startJob.ts` からも
 * `STATE_MACHINE_ARN` の読み取りに直接使うため export している。
 *
 * `STATE_MACHINE_ARN` を `ApiConfig`（＝全ハンドラ共通の `commonEnv`）に含めない理由:
 * ステートマシンは Launch/HandleFailure Lambda を呼び出す（Lambda ARN に依存）ため、
 * それらの Lambda の環境変数がステートマシンARNを参照すると CloudFormation の
 * 循環依存になる。`STATE_MACHINE_ARN` は StartExecution を呼ぶ startJob.ts だけが
 * 個別の環境変数として受け取る。
 */
export function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`必須の環境変数 ${name} が設定されていません`);
  }
  return value;
}

export function loadConfig(): ApiConfig {
  return {
    uploadBucket: required("UPLOAD_BUCKET"),
    outputBucket: required("OUTPUT_BUCKET"),
    cdnDomain: required("CDN_DOMAIN"),
    jobsTable: required("JOBS_TABLE"),
    workerImage: required("WORKER_IMAGE"),
    logGroup: required("WORKER_LOG_GROUP"),
    maxReplayBytes: Number(process.env.MAX_REPLAY_BYTES ?? 5 * 1024 * 1024),
    emailRateLimitTable: required("EMAIL_RATE_LIMIT_TABLE"),
    sesFromAddress: required("SES_FROM_ADDRESS"),
    webBaseUrl: required("WEB_BASE_URL"),
    ec2: {
      subnetIds: required("WORKER_SUBNET_IDS").split(","),
      region: process.env.AWS_REGION ?? "us-east-1",
      launchTemplateId: required("WORKER_LAUNCH_TEMPLATE_ID"),
    },
  };
}
