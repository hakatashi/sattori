/**
 * 自宅ワーカー（Issue #49）が使うAWS認証情報の供給。
 *
 * 自宅マシンにはEC2のインスタンスプロファイルが無いため、何らかの長期認証情報を
 * 置かざるを得ない。そのリスクを抑えるため、**長期キーは「ロールをassumeする権限
 * だけを持つIAMユーザー」に限定し、実際にS3やDynamoDBを触るのは assume して得た
 * 短命クレデンシャル**という二段構えにする（`HomeWorkerRole`、`infra/README.md`）。
 *
 * デーモン自身のAPI呼び出しにも、ワーカーコンテナへ渡す環境変数にも、同じここで
 * 発行した認証情報を使う。コンテナ内には認証情報を再取得する手段が無いので、
 * **コンテナ起動の直前に「ジョブ1本ぶんの残存時間があるか」を確かめ、足りなければ
 * assumeし直す**のが要点（録画の途中で認証エラーになると、そのジョブは丸ごと無駄になる）。
 *
 * `roleArn` を指定しない場合は環境の認証情報（`~/.aws/credentials`・環境変数・
 * インスタンスプロファイル等）をそのまま使う。ローカル検証用の逃げ道で、本番の
 * 自宅ワーカーでは必ずロールを指定すること。
 */
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";

/** 有効期限がこれを下回ったら再assumeする（通常のリフレッシュ判定）。 */
export const REFRESH_MARGIN_SEC = 15 * 60;

/**
 * コンテナへ渡す認証情報に最低限残っていてほしい時間。録画（最長60分）+720p変換+
 * アップロードを賄える長さにする。
 */
export const MIN_CONTAINER_TTL_SEC = 100 * 60;

/** AWS SDK の `credentials` にそのまま渡せる形。 */
export interface TemporaryCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

/**
 * デーモンが必要とする認証情報の供給元。テストでは差し替えるため、
 * `CredentialProvider` の実装ではなくこのインターフェースに依存する。
 */
export interface CredentialSource {
  /**
   * SDKクライアントへ渡す認証情報プロバイダ。`undefined` を返した場合は
   * SDK既定の解決チェーン（環境変数・共有クレデンシャル等）に委ねる。
   */
  clientCredentials(): (() => Promise<TemporaryCredentials>) | undefined;
  /** ワーカーコンテナへ渡す認証情報の環境変数。 */
  containerEnv(): Promise<Record<string, string>>;
}

export interface CredentialProviderOptions {
  region: string;
  roleArn?: string | null;
  durationSec?: number;
  sessionName?: string;
  log?: (message: string) => void;
  stsClient?: STSClient;
}

export class CredentialProvider implements CredentialSource {
  readonly #region: string;
  readonly #roleArn: string | null;
  readonly #durationSec: number;
  readonly #sessionName: string;
  readonly #log: (message: string) => void;
  #sts: STSClient | undefined;
  #credentials: TemporaryCredentials | null = null;
  /** 進行中の assume（同時に複数のジョブが起動しても1回で済ませるための直列化）。 */
  #inflight: Promise<TemporaryCredentials> | null = null;

  constructor(options: CredentialProviderOptions) {
    this.#region = options.region;
    this.#roleArn = options.roleArn ?? null;
    this.#durationSec = options.durationSec ?? 4 * 60 * 60;
    this.#sessionName = options.sessionName ?? "sattori-home-worker";
    this.#log = options.log ?? ((message): void => console.log(message));
    this.#sts = options.stsClient;
  }

  #stsClient(): STSClient {
    this.#sts ??= new STSClient({ region: this.#region });
    return this.#sts;
  }

  #remainingSec(): number {
    const expiration = this.#credentials?.expiration;
    if (expiration === undefined) {
      return 0;
    }
    return (expiration.getTime() - Date.now()) / 1000;
  }

  /** 残存時間が `minTtlSec` を下回っていれば assume し直す。 */
  async ensure(minTtlSec: number): Promise<TemporaryCredentials> {
    if (this.#roleArn === null) {
      throw new Error("roleArn が未指定のため assume できません");
    }
    if (this.#credentials !== null && this.#remainingSec() >= minTtlSec) {
      return this.#credentials;
    }
    this.#inflight ??= this.#assume().finally(() => {
      this.#inflight = null;
    });
    return await this.#inflight;
  }

  async #assume(): Promise<TemporaryCredentials> {
    const result = await this.#stsClient().send(
      new AssumeRoleCommand({
        RoleArn: this.#roleArn ?? undefined,
        RoleSessionName: this.#sessionName,
        DurationSeconds: this.#durationSec,
      }),
    );
    const creds = result.Credentials;
    if (
      creds?.AccessKeyId === undefined ||
      creds.SecretAccessKey === undefined ||
      creds.SessionToken === undefined
    ) {
      throw new Error("AssumeRole の応答に認証情報が含まれていません");
    }
    const credentials: TemporaryCredentials = {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
      ...(creds.Expiration === undefined ? {} : { expiration: creds.Expiration }),
    };
    this.#credentials = credentials;
    this.#log(
      `[credentials] ロールをassumeしました(期限: ${creds.Expiration?.toISOString() ?? "不明"})`,
    );
    return credentials;
  }

  /**
   * SDKクライアントへ渡すプロバイダ。SDK側は `expiration` を見て期限が近づくと
   * 再度この関数を呼ぶので、デーモンは長寿命のクライアントを1つ持ち続けてよい
   * （Python版が呼び出しの度に boto3 セッションを作り直していた部分に相当する）。
   */
  clientCredentials(): (() => Promise<TemporaryCredentials>) | undefined {
    if (this.#roleArn === null) {
      return undefined;
    }
    return async (): Promise<TemporaryCredentials> => await this.ensure(REFRESH_MARGIN_SEC);
  }

  /**
   * ワーカーコンテナへ渡す認証情報の環境変数。
   *
   * ロール未指定（検証用）の場合は環境の認証情報をそのまま解決して渡す。長期キーを
   * コンテナへ渡すことになるため、本番では必ず `roleArn` を指定すること。
   */
  async containerEnv(): Promise<Record<string, string>> {
    if (this.#roleArn === null) {
      const source = this.#stsClient().config.credentials;
      const resolved = typeof source === "function" ? await source() : source;
      if (resolved === undefined) {
        throw new Error("AWS認証情報が見つかりません");
      }
      const env: Record<string, string> = {
        AWS_ACCESS_KEY_ID: resolved.accessKeyId,
        AWS_SECRET_ACCESS_KEY: resolved.secretAccessKey,
      };
      if (resolved.sessionToken !== undefined) {
        env["AWS_SESSION_TOKEN"] = resolved.sessionToken;
      }
      return env;
    }

    const creds = await this.ensure(MIN_CONTAINER_TTL_SEC);
    return {
      AWS_ACCESS_KEY_ID: creds.accessKeyId,
      AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
      ...(creds.sessionToken === undefined ? {} : { AWS_SESSION_TOKEN: creds.sessionToken }),
    };
  }
}
