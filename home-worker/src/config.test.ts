/** 設定読み込みのテスト。環境変数は `loadConfig()` の引数として渡す。 */
import { GPU_RECORDING_GAME_IDS, SUPPORTED_GAME_IDS } from "@sattori/shared";
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

  it("既定値は録画対応タイトル(GPU専用タイトルを除く)と控えめな並列度、能力はすべて宣言する", () => {
    const config = loadConfig(env());

    // GPU描画必須タイトル（th06nc、Issue #241）は自宅マシンにGPUが無い前提のため
    // 既定から除外される（多層防御、`workerRouting.ts`の`offerToHomeWorker: false`と対）。
    expect(config.supportedGames).toEqual(
      SUPPORTED_GAME_IDS.filter((game) => !GPU_RECORDING_GAME_IDS.includes(game)),
    );
    for (const game of GPU_RECORDING_GAME_IDS) {
      expect(config.supportedGames).not.toContain(game);
    }
    expect(config.maxConcurrency).toBe(2);
  });

  it("GPU描画必須タイトル(th06nc)をHOME_WORKER_SUPPORTED_GAMESで明示指定するとエラー", () => {
    expect(() => loadConfig(env({ HOME_WORKER_SUPPORTED_GAMES: "th06nc" }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ HOME_WORKER_SUPPORTED_GAMES: "th07,th06nc" }))).toThrow(
      ConfigError,
    );
  });

  it("タイトルはカンマ区切りで上書きできる", () => {
    const config = loadConfig(
      env({
        HOME_WORKER_SUPPORTED_GAMES: "th07, th08",
        HOME_WORKER_MAX_CONCURRENCY: "4",
      }),
    );

    expect(config.supportedGames).toEqual(["th07", "th08"]);
    expect(config.maxConcurrency).toBe(4);
  });

  it("未知のタイトルは起動時に弾く", () => {
    // typoで「1件も引き受けないワーカー」が黙って出来上がるのを防ぐ。
    expect(() => loadConfig(env({ HOME_WORKER_SUPPORTED_GAMES: "th99" }))).toThrow(ConfigError);
  });

  it("ネットワーク疎通確認の間隔は既定60秒、環境変数で上書きできる(Issue #160)", () => {
    expect(loadConfig(env()).networkCheckIntervalSec).toBe(60);
    expect(
      loadConfig(env({ HOME_WORKER_NETWORK_CHECK_INTERVAL_SEC: "30" })).networkCheckIntervalSec,
    ).toBe(30);
  });

  it("タイトル資産キャッシュディレクトリは既定未設定、環境変数で指定できる(Issue #104)", () => {
    expect(loadConfig(env()).titleAssetsCacheDir).toBeNull();
    expect(
      loadConfig(env({ HOME_WORKER_TITLE_ASSETS_CACHE_DIR: "/var/cache/sattori-title-assets" }))
        .titleAssetsCacheDir,
    ).toBe("/var/cache/sattori-title-assets");
  });

  it("docker追加引数はシェルと同じ規則で分割する", () => {
    expect(loadConfig(env({ HOME_WORKER_DOCKER_ARGS: "--shm-size=1g --memory 8g" })).dockerExtraArgs)
      .toEqual(["--shm-size=1g", "--memory", "8g"]);
    expect(
      loadConfig(env({ HOME_WORKER_DOCKER_ARGS: '--mount "src=/tmp/a b,dst=/c"' })).dockerExtraArgs,
    ).toEqual(["--mount", "src=/tmp/a b,dst=/c"]);
  });
});
