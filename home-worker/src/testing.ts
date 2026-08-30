/**
 * テスト専用のヘルパー（`tsconfig.json` の `exclude` によりビルド対象外）。
 * Python版の `tests/helpers.py` に相当する。
 */
import type { Config } from "./config.js";

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    region: "eu-south-2",
    jobsTable: "jobs",
    workersTable: "workers",
    logGroup: "/sattori/worker",
    workerImage: "registry/sattori-worker:latest",
    workerId: "home-1",
    roleArn: null,
    maxConcurrency: 2,
    capabilities: [],
    supportedGames: ["th06", "th07"],
    pollIntervalSec: 3,
    loadThreshold: 0.7,
    dockerCpus: null,
    dockerExtraArgs: [],
    drainTimeoutSec: 150 * 60,
    credentialDurationSec: 4 * 60 * 60,
    networkCheckIntervalSec: 60,
    titleAssetsCacheDir: null,
    ...overrides,
  };
}
