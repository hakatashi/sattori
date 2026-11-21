#include "core/runtime_config.h"
#include "core/log.h"

namespace autoplay {

namespace {
RuntimeConfig g_config;
volatile LONG g_loaded = 0;
}  // namespace

const RuntimeConfig& Config() {
    // DllMain(ローダーロック下・単一スレッド)の InitRuntimeConfig() で読み終えている前提。
    // 読む前に呼ばれた場合の保険として、ここでも読む(値は同じなので競合しても害はない)。
    if (!g_loaded) {
        g_config = ParseRuntimeConfig(getenv);
        InterlockedExchange(&g_loaded, 1);
    }
    return g_config;
}

void InitRuntimeConfig() {
    const RuntimeConfig& c = Config();
    Log("RuntimeConfig: FPS_LIMIT_TARGET_HZ=%.2f SPEED_HACK_MULTIPLIER=%.4f D3D11_DECODE_BC7=%d "
        "D3DX_AREA_FILTER=%s MENU_WAIT_EXTRA_SCALE=%.2f SYNC_MARKER_TRIGGER=%s",
        c.fpsLimitTargetHz, c.speedHackMultiplier, (int)c.d3d11DecodeBc7,
        c.d3dxAreaFilterDisabled ? "0" : "(default)", c.menuWaitExtraScale,
        c.syncMarkerTrigger[0] ? c.syncMarkerTrigger : "(none)");
}

}  // namespace autoplay
