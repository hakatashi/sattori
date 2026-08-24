/** コンテナのネットワーク疎通確認（Issue #160）のテスト。 */
import { describe, expect, it } from "vitest";
import { NETWORK_CHECK_IMAGE, checkContainerNetwork, networkCheckUrl } from "./network.js";
import type { CommandResult, RunCommand } from "./runner.js";
import { makeConfig } from "./testing.js";

const result = (code = 0): CommandResult => ({ code, stdout: "", stderr: "" });

describe("networkCheckUrl", () => {
  it("設定リージョンのDynamoDBエンドポイントを使う", () => {
    expect(networkCheckUrl(makeConfig({ region: "eu-south-2" }))).toBe(
      "https://dynamodb.eu-south-2.amazonaws.com/",
    );
  });
});

describe("checkContainerNetwork", () => {
  it("軽量イメージをdocker runで実際に起動して確認する", async () => {
    const calls: string[][] = [];
    const run: RunCommand = async (command) => {
      calls.push(command);
      return result();
    };

    const healthy = await checkContainerNetwork(makeConfig({ region: "eu-south-2" }), { run });

    expect(healthy).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 4)).toEqual(["docker", "run", "--rm", NETWORK_CHECK_IMAGE]);
    expect(calls[0]).toContain("https://dynamodb.eu-south-2.amazonaws.com/");
  });

  it("到達できなければfalse(コンテナのネットワーク名前空間だけが壊れているケース)", async () => {
    const run: RunCommand = async () => result(28); // curlのタイムアウト終了コード

    await expect(checkContainerNetwork(makeConfig(), { run })).resolves.toBe(false);
  });
});
