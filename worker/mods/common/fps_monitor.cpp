#include "fps_monitor.h"
#include "dinput_hook.h"
#include "logging.h"

namespace autoplay {

struct FpsMonitorArgs {
    unsigned int intervalMs;
};

static DWORD WINAPI FpsMonitorThread(LPVOID param) {
    FpsMonitorArgs* args = (FpsMonitorArgs*)param;
    unsigned int intervalMs = args->intervalMs;
    delete args;

    LONG lastCount = g_hookCallCount;
    DWORD lastTick = GetTickCount();
    for (;;) {
        Sleep(intervalMs);
        LONG current = g_hookCallCount;
        DWORD now = GetTickCount();
        LONG delta = current - lastCount;
        DWORD elapsedMs = now - lastTick;
        double hz = elapsedMs > 0 ? (delta * 1000.0 / elapsedMs) : 0.0;
        Log("FpsMonitor: %ld GetDeviceState calls in %lu ms (%.1f Hz)", delta, elapsedMs, hz);
        lastCount = current;
        lastTick = now;
    }
    return 0;
}

void StartFpsMonitorThread(unsigned int intervalMs) {
    FpsMonitorArgs* args = new FpsMonitorArgs{intervalMs};
    CreateThread(NULL, 0, FpsMonitorThread, args, 0, NULL);
}

} // namespace autoplay
