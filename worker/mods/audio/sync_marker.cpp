#include "audio/sync_marker.h"
#include "core/log.h"
#include "core/log_contract.h"
#include "core/runtime_config.h"

namespace autoplay::sync_marker {

double EpochNow() {
    FILETIME ft;
    GetSystemTimePreciseAsFileTime(&ft);
    ULONGLONG t = ((ULONGLONG)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
    return (double)(t - 116444736000000000ULL) / 1e7;
}

void LogPlayed(double epoch, double playCallSec, DWORD rate, HRESULT hr) {
    Log(log_contract::kSyncMarkerPlayedFmt, epoch, playCallSec, (unsigned long)rate,
        (unsigned long)kSamples, (int)kAmp, (unsigned long)kSeed, (unsigned long)hr);
}

namespace {

Watch g_watch;

DWORD WINAPI WatchThread(LPVOID) {
    const char* path = Config().syncMarkerTrigger;
    // 録画は数十分に及ぶことがあるが、トリガーは録画開始直後に置かれる。念のため長めに待つ。
    for (int i = 0; i < 20 * 60 * 200; i++) {
        if (GetFileAttributesA(path) != INVALID_FILE_ATTRIBUTES && (!g_watch.ready || g_watch.ready())) {
            Log("%s: trigger found (%s)", g_watch.tag, path);
            g_watch.onTrigger();
            return 0;
        }
        Sleep(5);
    }
    if (g_watch.logTimeout) Log("%s: trigger not found within timeout", g_watch.tag);
    return 0;
}

}  // namespace

bool Arm(const Watch& watch, const char* armedBy) {
    const RuntimeConfig& cfg = Config();
    if (cfg.FrameSyncEnabled() || cfg.frameSyncAudio[0]) return false;
    const char* trig = cfg.syncMarkerTrigger;
    if (!trig[0]) return false;
    // 監視は1プロセスに1つだけ(DirectSound と WASAPI を両方フックする th06c/th06nc でも、
    // 鳴らすのは Arm を呼んだ側だけ)。
    static bool s_armed = false;
    if (s_armed) return true;
    s_armed = true;
    g_watch = watch;
    HANDLE th = CreateThread(nullptr, 0, WatchThread, nullptr, 0, nullptr);
    if (th) CloseHandle(th);
    Log("%s: sync marker armed (trigger=%s)", armedBy, trig);
    return true;
}

}  // namespace autoplay::sync_marker
