/** 認証情報供給のテスト。 */
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { CredentialProvider, MIN_CONTAINER_TTL_SEC } from "./credentials.js";

const stsMock = mockClient(STSClient);

beforeEach(() => {
  stsMock.reset();
});

/** 指定秒後に期限切れになる一時認証情報を返す STS のモック。 */
function assumeExpiringIn(seconds: number): void {
  stsMock.on(AssumeRoleCommand).resolves({
    Credentials: {
      AccessKeyId: "AKIA",
      SecretAccessKey: "secret",
      SessionToken: "token",
      Expiration: new Date(Date.now() + seconds * 1000),
    },
  });
}

const makeProvider = (): CredentialProvider =>
  new CredentialProvider({
    region: "eu-south-2",
    roleArn: "arn:aws:iam::1:role/home",
    log: () => undefined,
    stsClient: new STSClient({ region: "eu-south-2" }),
  });

describe("CredentialProvider", () => {
  it("コンテナへ渡す認証情報は環境変数の形で返す", async () => {
    assumeExpiringIn(4 * 60 * 60);
    const provider = makeProvider();

    const env = await provider.containerEnv();

    expect(env["AWS_ACCESS_KEY_ID"]).toBe("AKIA");
    expect(env["AWS_SESSION_TOKEN"]).toBe("token");
    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(1);
  });

  it("残存時間がジョブ1本に足りなければassumeし直す", async () => {
    // 期限切れ間近の認証情報をコンテナへ渡すと、録画の途中で認証エラーになり
    // そのジョブが丸ごと無駄になる。
    assumeExpiringIn(MIN_CONTAINER_TTL_SEC - 60);
    const provider = makeProvider();

    await provider.containerEnv();
    await provider.containerEnv();

    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(2);
  });

  it("十分な残存時間があれば再assumeしない", async () => {
    assumeExpiringIn(MIN_CONTAINER_TTL_SEC + 3600);
    const provider = makeProvider();

    await provider.containerEnv();
    await provider.containerEnv();

    expect(stsMock.commandCalls(AssumeRoleCommand)).toHaveLength(1);
  });
});
