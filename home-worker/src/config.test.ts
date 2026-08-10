/** 設定読み込みのテスト。環境変数は `loadConfig()` の引数として渡す。 */
import { SUPPORTED_GAME_IDS } from "@sattori/shared";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";
import type { Environment } from "./config.js";

const REQUIRED_ENV: Environment = {
  JOBS_TABLE: "sattori-jobs",
  WORKERS_TABLE: "sattori-workers",
  WORKER_IMAGE: "registry.example/sattori-worker:latest",
};

const env = (extra: Environment = {}): Environment => ({ ...REQUIRED_ENV, ...extra });

describe("loadConfig", () => {
  it("必須の環境変数が無ければエラー", () => {
    expect(() => loadConfig({ WORKERS_TABLE: "w", WORKER_IMAGE: "i" })).toThrow(ConfigError);
  });

  it("既定値は録画対応タイトルと控えめな並列度", () => {
    const config = loadConfig(env());

    expect(config.supportedGames).toEqual([...SUPPORTED_GAME_IDS]);
    expect(config.maxConcurrency).toBe(2);
    expect(config.capabilities).toEqual([]);
  });

  it("能力とタイトルはカンマ区切りで上書きできる", () => {
    const config = loadConfig(
      env({
        HOME_WORKER_SUPPORTED_GAMES: "th07, th08",
        HOME_WORKER_CAPABILITIES: "slow-motion-recording",
        HOME_WORKER_MAX_CONCURRENCY: "4",
      }),
    );

    expect(config.supportedGames).toEqual(["th07", "th08"]);
    expect(config.capabilities).toEqual(["slow-motion-recording"]);
    expect(config.maxConcurrency).toBe(4);
  });

  it("未知の能力・タイトルは起動時に弾く", () => {
    // typoで「1件も引き受けないワーカー」が黙って出来上がるのを防ぐ。
    expect(() => loadConfig(env({ HOME_WORKER_CAPABILITIES: "fast-forward" }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ HOME_WORKER_SUPPORTED_GAMES: "th99" }))).toThrow(ConfigError);
  });

  it("docker追加引数はシェルと同じ規則で分割する", () => {
    expect(loadConfig(env({ HOME_WORKER_DOCKER_ARGS: "--shm-size=1g --memory 8g" })).dockerExtraArgs)
      .toEqual(["--shm-size=1g", "--memory", "8g"]);
    expect(
      loadConfig(env({ HOME_WORKER_DOCKER_ARGS: '--mount "src=/tmp/a b,dst=/c"' })).dockerExtraArgs,
    ).toEqual(["--mount", "src=/tmp/a b,dst=/c"]);
  });
});
