#include "present/limiter.h"
#include "present/bus.h"
#include "core/runtime_config.h"

namespace autoplay {

namespace {

double g_targetIntervalSec = 1.0 / 60.0;
LARGE_INTEGER g_qpcFreq = {};
LARGE_INTEGER g_lastPresentQpc = {};
bool g_haveLastPresent = false;

// QueryPerformanceCounter はこのDLL自身のインポートから呼ぶので、exe の IAT を書き換える
// clock/speed_hack・clock/fps_display の偽装を受けない(実時間の基準として使える)。
void BeforePresent(const present::Frame&, unsigned& flags) {
    if (!(flags & present::kThrottle)) return;
    LARGE_INTEGER now;
    QueryPerformanceCounter(&now);
    if (g_haveLastPresent) {
        double elapsed = (double)(now.QuadPart - g_lastPresentQpc.QuadPart) /
                         (double)g_qpcFreq.QuadPart;
        double remaining = g_targetIntervalSec - elapsed;
        if (remaining > 0.0) {
            // Sleep()はミリ秒粒度なので、端数はビジーウェイトで詰める
            // (QueryPerformanceCounterは実測で正確なため信頼できる基準として使う)。
            DWORD ms = (DWORD)(remaining * 1000.0);
            if (ms > 0) Sleep(ms);
            LARGE_INTEGER spin;
            do {
                QueryPerformanceCounter(&spin);
            } while ((double)(spin.QuadPart - now.QuadPart) / (double)g_qpcFreq.QuadPart <
                     remaining);
        }
    }
}

void AfterPresent(const present::Frame&, unsigned, HRESULT) {
    QueryPerformanceCounter(&g_lastPresentQpc);
    g_haveLastPresent = true;
}

}  // namespace

double InstallFpsLimiterHandlers() {
    QueryPerformanceFrequency(&g_qpcFreq);
    const double targetHz = Config().FrameSyncEnabled() ? 60.0 : Config().TargetHzOr(60.0);
    g_targetIntervalSec = 1.0 / targetHz;
    present::AddPreHandler(BeforePresent, present::kPriorityLimiter);
    present::AddPostHandler(AfterPresent, present::kPriorityLimiter);
    return targetHz;
}

}  // namespace autoplay
