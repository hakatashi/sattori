/** ワーカーコンテナ実行（runner）のテスト。 */
import { ECRClient, GetAuthorizationTokenCommand } from "@aws-sdk/client-ecr";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ContainerRun,
  ImagePreparationError,
  buildDockerCommand,
  containerName,
  ecrLogin,
  pullImage,
  redactCommand,
} from "./runner.js";
import type { CommandResult, RunCommand } from "./runner.js";
import { makeConfig } from "./testing.js";

const ecrMock = mockClient(ECRClient);

beforeEach(() => {
  ecrMock.reset();
  ecrMock.on(GetAuthorizationTokenCommand).resolves({
    authorizationData: [
      { authorizationToken: Buffer.from("AWS:password").toString("base64") },
    ],
  });
});

const result = (code = 0, stderr = ""): CommandResult => ({ code, stdout: "", stderr });

const ecr = (): ECRClient => new ECRClient({ region: "eu-south-2" });

describe("buildDockerCommand", () => {
  it("環境変数をそのままdocker runへ渡す", () => {
    const config = makeConfig({ dockerCpus: "4", dockerExtraArgs: ["--shm-size=1g"] });

    const cmd = buildDockerCommand(config, "job-1", { JOB_ID: "job-1", GAME: "th07" });

    expect(cmd.slice(0, 5)).toEqual(["docker", "run", "--rm", "--name", containerName("job-1")]);
    expect(cmd).toContain("--cpus");
    expect(cmd).toContain("4");
    expect(cmd).toContain("--shm-size=1g");
    expect(cmd).toContain("JOB_ID=job-1");
    expect(cmd).toContain("GAME=th07");
    expect(cmd.at(-1)).toBe(config.workerImage);
  });
});

describe("redactCommand", () => {
  it("ログ用のコマンドはtaskTokenと認証情報を伏せる", () => {
    const cmd = buildDockerCommand(makeConfig(), "job-1", {
      TASK_TOKEN: "secret",
      AWS_SECRET_ACCESS_KEY: "key",
      GAME: "th07",
    });

    const redacted = redactCommand(cmd);

    expect(redacted).toContain("TASK_TOKEN=***");
    expect(redacted).toContain("AWS_SECRET_ACCESS_KEY=***");
    expect(redacted).toContain("GAME=th07");
    expect(redacted).not.toContain("TASK_TOKEN=secret");
  });
});

describe("ecrLogin", () => {
  it("ECRログインはトークンを標準入力で渡す", async () => {
    const calls: { command: string[]; input?: string | undefined }[] = [];
    const run: RunCommand = async (command, options) => {
      calls.push({ command, input: options?.input });
      return result();
    };

    await ecrLogin(ecr(), "registry.example/sattori-worker:latest", { log: () => undefined, run });

    expect(calls[0]?.command.slice(0, 4)).toEqual(["docker", "login", "--username", "AWS"]);
    expect(calls[0]?.command.at(-1)).toBe("registry.example");
    expect(calls[0]?.input).toBe("password");
  });

  it("ECRログイン失敗はImagePreparationError", async () => {
    const run: RunCommand = async () => result(1, "denied");

    await expect(
      ecrLogin(ecr(), "registry.example/img:latest", { log: () => undefined, run }),
    ).rejects.toBeInstanceOf(ImagePreparationError);
  });
});

describe("pullImage", () => {
  it("pullは数回まで再試行してから諦める", async () => {
    const attempts: string[][] = [];
    const run: RunCommand = async (command) => {
      attempts.push(command);
      return result(1, "timeout");
    };

    await expect(
      pullImage("registry.example/img:latest", { log: () => undefined, run }),
    ).rejects.toBeInstanceOf(ImagePreparationError);
    expect(attempts).toHaveLength(3);
  });

  it("pullが成功すれば再試行しない", async () => {
    const attempts: string[][] = [];
    const run: RunCommand = async (command) => {
      attempts.push(command);
      return result();
    };

    await pullImage("registry.example/img:latest", { log: () => undefined, run });

    expect(attempts).toHaveLength(1);
  });
});

describe("ContainerRun", () => {
  it("コンテナ出力を1行ずつ渡し終了コードを返す", async () => {
    const lines: string[] = [];
    const container = new ContainerRun(
      makeConfig(),
      "job-1",
      { JOB_ID: "job-1" },
      {
        log: () => undefined,
        spawnContainer: async (_command, onLine) => {
          onLine("録画開始");
          onLine("録画完了");
          return 0;
        },
      },
    );

    await expect(container.run((line) => lines.push(line))).resolves.toBe(0);
    expect(lines).toEqual(["録画開始", "録画完了"]);
    expect(container.killed).toBe(false);
  });

  it("killはdocker killを発行する", async () => {
    const calls: string[][] = [];
    const container = new ContainerRun(
      makeConfig(),
      "job-1",
      {},
      {
        log: () => undefined,
        run: async (command) => {
          calls.push(command);
          return result();
        },
      },
    );

    await container.kill();

    expect(container.killed).toBe(true);
    expect(calls[0]).toEqual(["docker", "kill", containerName("job-1")]);
  });
});
