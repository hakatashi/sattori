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
}

export interface Ec2LaunchConfig {
  /** Docker 導入済みのベース AMI ID。 */
  amiId: string;
  /** 起動先サブネット（複数AZ対応は将来 Spot Fleet で拡張）。 */
  subnetId: string;
  /** ワーカーに付与するインスタンスプロファイル（ECR/S3/DynamoDB権限）。 */
  instanceProfileArn: string;
  /** セキュリティグループ ID。 */
  securityGroupId: string;
  /** インスタンスタイプ。PoC結果より c7i.xlarge を既定とする。 */
  instanceType: string;
  /** AWS リージョン。 */
  region: string;
}

function required(name: string): string {
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
    ec2: {
      amiId: required("WORKER_AMI_ID"),
      subnetId: required("WORKER_SUBNET_ID"),
      instanceProfileArn: required("WORKER_INSTANCE_PROFILE_ARN"),
      securityGroupId: required("WORKER_SECURITY_GROUP_ID"),
      instanceType: process.env.WORKER_INSTANCE_TYPE ?? "c7i.xlarge",
      region: process.env.AWS_REGION ?? "us-east-1",
    },
  };
}
