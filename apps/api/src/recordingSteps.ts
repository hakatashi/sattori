import { isGpuStep } from "@sattori/shared";
import type { AdminSettings, RecordingStepFilter } from "@sattori/shared";
import type { ApiConfig } from "./config.js";
import { getSettings } from "./settings.js";

/**
 * 管理設定（本番での実機検証用、Issue #296・#316・#317）から、試さない録画の段の判定を作る。
 *
 * - `skipGpuSteps`: GPUの段をすべて除く。
 * - `forceGpuFallbackRegion`: 一次リージョンのGPUの段を除く（フォールバック先から試す）。
 */
export function recordingStepFilterFor(
  settings: Pick<AdminSettings, "forceGpuFallbackRegion" | "skipGpuSteps"> | null,
  primaryRegion: string,
): RecordingStepFilter {
  return (step) => {
    if (!settings || !isGpuStep(step)) {
      return false;
    }
    if (settings.skipGpuSteps) {
      return true;
    }
    return settings.forceGpuFallbackRegion && step.kind === "ec2" && step.region === primaryRegion;
  };
}

/**
 * 管理設定を読んで段の除外判定を返す。設定の読み取り失敗で録画を止めない（除外なしで続ける）。
 * `AcquireGpuSlot`と`Launch`が同じ判定を使い、GPUの段を飛ばすジョブにGPU枠を確保させない。
 */
export async function loadRecordingStepFilter(
  config: ApiConfig,
  jobId: string,
): Promise<RecordingStepFilter> {
  const settings = await getSettings(config.settingsTable).catch((err: unknown) => {
    console.error(
      JSON.stringify({
        event: "recording_step_settings_read_failed",
        jobId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  });
  if (settings?.skipGpuSteps || settings?.forceGpuFallbackRegion) {
    console.log(
      JSON.stringify({
        event: "recording_steps_overridden",
        jobId,
        skipGpuSteps: settings.skipGpuSteps,
        forceGpuFallbackRegion: settings.forceGpuFallbackRegion,
      }),
    );
  }
  return recordingStepFilterFor(settings, config.ec2.region);
}
