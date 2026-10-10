/**
 * GPUワーカーの容量不足時フォールバック（Issue #296、`docs/decisions/0061`）で、
 * 本体スタック（`SattoriStack`、eu-south-2）とフォールバックスタック
 * （`SattoriGpuFallbackStack`、eu-north-1）が共有する固定名。
 *
 * **2つのスタックの間にはCloudFormationの参照（`crossRegionReferences`）を張らない**。
 * 本体はフォールバック先のLaunch Template・サブネットを、フォールバック先は本体の
 * インスタンスプロファイルを必要とするため、参照を張ると循環する。代わりに双方が
 * ここの固定名だけを知り、デプロイ順（フォールバック → 本体）で解決する
 * （`bin/sattori.ts`、`infra/README.md`）。
 */

/** フォールバック先リージョン。 */
export const GPU_FALLBACK_REGION = "eu-north-1";

/**
 * フォールバック先でg6f.2xlargeを提供するAZ（2026-10-11に`describe-instance-type-offerings`
 * で確認。eu-north-1cは提供していない）。提供しないAZのサブネットをEC2 Fleetの候補に
 * 含めると毎回エラーが混ざるため、VPC自体をこの2AZに限定する。
 */
export const GPU_FALLBACK_AVAILABILITY_ZONES = ["eu-north-1a", "eu-north-1b"];

/** フォールバック先のGPU Launch Template名（Launch Lambdaが名前で引く）。 */
export const GPU_FALLBACK_LAUNCH_TEMPLATE_NAME = "sattori-gpu-worker";

/** フォールバック先のワーカー用サブネットに付けるタグキー（値は`"true"`）。 */
export const GPU_FALLBACK_SUBNET_TAG_KEY = "sattori:gpuWorkerSubnet";

/**
 * フォールバック先のLaunch Templateが参照するインスタンスプロファイル名。本体スタックが
 * 既存の`WorkerRole`に対して**追加で**作る（既存のプロファイルに固定名を付けると
 * 置き換えになり、実行中のワーカーを巻き込むため）。IAMはグローバルなので
 * 他リージョンのLaunch Templateからも名前で参照できる。
 */
export const GPU_WORKER_REMOTE_INSTANCE_PROFILE_NAME = "sattori-gpu-worker-remote";

/** GPUワーカーのECRリポジトリ名（本体とフォールバック先のレプリカで同名）。 */
export const GPU_WORKER_REPOSITORY_NAME = "sattori-worker-gpu";

/**
 * GPU用カスタムAMIのIDをCDKコンテキスト`gpuWorkerAmiIds`（リージョン→AMI ID）から引く。
 * AMIはリージョンを跨いで使えないため、フォールバック先には`copy-image`した別IDが要る
 * （`build-gpu-worker-ami` skill）。未設定ならsynth自体を失敗させる——誤ってCPU系AMIの
 * ままGPU系を起動する事故を防ぐため（`docs/decisions/0046`）。
 */
export function gpuWorkerAmiIdFor(
  context: unknown,
  region: string,
): string {
  // `cdk synth -c gpuWorkerAmiIds='{...}'`で一時的に上書きした場合はJSON文字列で届く。
  const map: unknown = typeof context === "string" ? JSON.parse(context) : context;
  const amiId =
    typeof map === "object" && map !== null ? (map as Record<string, unknown>)[region] : undefined;
  if (typeof amiId !== "string" || !/^ami-[0-9a-f]+$/.test(amiId)) {
    throw new Error(
      `gpuWorkerAmiIds コンテキスト値に ${region} のAMI IDがありません。cdk.json の context に` +
        ` "gpuWorkerAmiIds": { "${region}": "ami-xxxx" } を設定してください` +
        "（`build-gpu-worker-ami` skill参照）。",
    );
  }
  return amiId;
}
