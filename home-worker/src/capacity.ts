/**
 * 自宅マシンの余力判定（Issue #49 の論点4）。
 *
 * 判定は2段構え:
 *
 * - `maxConcurrency`: 同時録画数の上限。
 * - ロードアベレージ: 上限に達していなくても、開発者が自宅マシンを別用途で使って
 *   いる最中に録画を引き受けて母艦を重くしないためのガード。
 *
 * **新規claimを止めることと、実行中ジョブを止めることは別**である（Issue #49 の
 * 論点4）。この関数群は前者にしか使わない。走り出した録画は最後まで完走させる
 * ——中断すればそのジョブは丸ごとやり直しになり、節約したCPU時間よりはるかに
 * 大きな無駄になるため。
 */
import os from "node:os";
import type { Config } from "./config.js";

export interface LoadSource {
  /** 1分/5分/15分のロードアベレージ。 */
  loadavg?: () => number[];
  cpuCount?: () => number;
}

/** 1コアあたりの1分間ロードアベレージ。取得できない環境では0.0。 */
export function loadPerCpu(source: LoadSource = {}): number {
  const loadavg = source.loadavg ?? ((): number[] => os.loadavg());
  const cpuCount = source.cpuCount ?? ((): number => os.cpus().length);
  let load: number;
  try {
    load = loadavg()[0] ?? 0;
  } catch {
    // Node の `os.loadavg()` は非対応プラットフォームで例外ではなく [0,0,0] を
    // 返すが、差し替え可能にしてある以上ここで落ちないようにしておく。
    return 0;
  }
  if (!Number.isFinite(load)) {
    return 0;
  }
  const cpus = cpuCount() || 1;
  return load / cpus;
}

/** 新しいジョブをclaimしてよいか。 */
export function canAccept(config: Config, activeJobs: number, load?: number): boolean {
  if (activeJobs >= config.maxConcurrency) {
    return false;
  }
  const current = load ?? loadPerCpu();
  return current <= config.loadThreshold;
}
