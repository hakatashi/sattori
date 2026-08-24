/**
 * ワーカーコンテナが実際に使うDockerブリッジネットワークから、AWSへの疎通を確認する
 * （Issue #160）。
 *
 * 自宅サーバーは「ホストは正常だがコンテナのネットワーク名前空間だけが到達不能」に
 * なりうる（VPNのpolicy routingがDockerのブリッジサブネットを除外し損ねる等、ホスト
 * 側の設定はこのリポジトリの管轄外）。ハートビート（`heartbeat.ts`）はホストの
 * プロセスが送るためこの種の障害では健全に見え続け、AWS側の`Launch`（オファーの
 * 発行元）からは検知できない。**ホストから確認しても意味が無い**——障害はコンテナの
 * ネットワーク名前空間だけに起きるため、`docker run`で実際にコンテナを1つ起動して
 * 確認する。
 */
import type { Config } from "./config.js";
import type { RunCommand } from "./runner.js";
import { defaultRunCommand } from "./runner.js";

/**
 * 疎通確認専用の軽量イメージ。ワーカーイメージ（`worker/`、Wine+Xvfb+ffmpeg入り）を
 * 流用しないのは、内部にcurl相当のツールがある前提をこのデーモンへ持ち込みたくない
 * ため（「録画パイプラインのロジックは一切持たない」という構造上の分離、
 * `README.md`冒頭）。pull自体はDockerデーモンがホストのネットワークで行うため、
 * ここで検知したい障害（コンテナのネットワーク名前空間だけの到達不能）とは無関係に
 * 成功する。
 */
export const NETWORK_CHECK_IMAGE = "curlimages/curl:latest";

/** 1回の確認にかける上限(秒)。長すぎるとオファーの待機時間を無駄に食う。 */
export const NETWORK_CHECK_TIMEOUT_SEC = 5;

export interface NetworkCheckOptions {
  run?: RunCommand;
}

/**
 * 疎通確認先のURL。DynamoDBは録画ワーカーが（ハートビート・進捗更新等で）最も
 * 高頻度に叩くエンドポイントなので代表として使う。認証は不要——TCP+TLSで到達し、
 * 何らかのHTTP応答が返ってくれば（401等のエラー応答でも）疎通ありと判断できる。
 */
export function networkCheckUrl(config: Config): string {
  return `https://dynamodb.${config.region}.amazonaws.com/`;
}

/**
 * コンテナのネットワーク名前空間からAWSへ到達できるかを確認する。
 * `curl`の終了コードだけを見る（`-f`を付けないので、HTTPエラー応答は「到達できて
 * いる」証拠として成功扱いになる。失敗するのは接続不可・タイムアウトのときだけ）。
 */
export async function checkContainerNetwork(
  config: Config,
  options: NetworkCheckOptions = {},
): Promise<boolean> {
  const run = options.run ?? defaultRunCommand;
  const result = await run([
    "docker",
    "run",
    "--rm",
    NETWORK_CHECK_IMAGE,
    "-s",
    "-o",
    "/dev/null",
    "--max-time",
    String(NETWORK_CHECK_TIMEOUT_SEC),
    networkCheckUrl(config),
  ]);
  return result.code === 0;
}
