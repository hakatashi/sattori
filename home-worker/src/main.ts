/**
 * 常駐デーモンのエントリポイント（`node dist/main.js`）。
 *
 * SIGTERM/SIGINT を受けたら新規claimを止めるだけで、実行中のジョブは完走を待つ
 * （systemd の `TimeoutStopSec` をドレインの上限より長く取ること。README参照）。
 */
import { ConfigError, loadConfig } from "./config.js";
import type { Config } from "./config.js";
import { HomeWorkerDaemon, log } from "./daemon.js";

async function main(): Promise<number> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`設定エラー: ${err.message}`);
      return 2;
    }
    throw err;
  }

  const daemon = new HomeWorkerDaemon(config);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      log(`シグナル ${signal} を受信しました。新規claimを停止します`);
      daemon.stop();
    });
  }

  await daemon.runForever();
  return 0;
}

process.exitCode = await main();
