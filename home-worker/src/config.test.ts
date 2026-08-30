/** 設定読み込みのテスト。環境変数は `loadConfig()` の引数として渡す。 */
import { SUPPORTED_GAME_IDS, WORKER_CAPABILITIES } from "@sattori/shared";
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

  it("既定値は録画対応タイトルと控えめな並列度、能力はすべて宣言する", () => {
    const config = loadConfig(env());

    expect(config.supportedGames).toEqual([...SUPPORTED_GAME_IDS]);
    expect(config.maxConcurrency).toBe(2);
    // 低速録画（Issue #68）の実体はEC2と共通のワーカーイメージ側にあり、デーモンは
    // 環境変数をそのまま`docker run`へ渡すだけなので、自宅ワーカーは無条件に対応できる。
    expect(config.capabilities).toEqual([...WORKER_CAPABILITIES]);
  });

  it("能力は空文字で明示的に降りられる（自宅マシンを長時間占有されたくない場合）", () => {
    expect(loadConfig(env({ HOME_WORKER_CAPABILITIES: "" })).capabilities).toEqual([]);
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
