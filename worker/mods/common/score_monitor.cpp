#include "score_monitor.h"
#include "logging.h"
#include <string.h>

namespace autoplay {

namespace {

ScoreMonitorConfig g_config;

// 指定RVAが実際に読める(コミット済みの)ページかを確認してから読む。
// 静的領域なので通常は常に読めるが、想定外バイナリにRVAを指定した場合に
// アクセス違反でゲームごと落とさないための保険。
bool SafeRead(uintptr_t addr, void* out, SIZE_T size) {
    if (!addr) return false;
    MEMORY_BASIC_INFORMATION mbi;
    if (VirtualQuery((LPCVOID)addr, &mbi, sizeof(mbi)) != sizeof(mbi)) return false;
    if (mbi.State != MEM_COMMIT) return false;
    if (mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD)) return false;
    if ((uintptr_t)mbi.BaseAddress + mbi.RegionSize < addr + size) return false;
    memcpy(out, (const void*)addr, size);
    return true;
}

DWORD WINAPI ScoreMonitorThread(LPVOID) {
    uintptr_t base = (uintptr_t)GetModuleHandleA(NULL);
    if (!base) {
        Log("ScoreMonitor: GetModuleHandleA(NULL) failed, monitor disabled");
        return 1;
    }
    Log("ScoreMonitor: started (base=0x%08X score_rva=0x%08X interval=%lums)",
        (unsigned)base, g_config.scoreRva, (unsigned long)g_config.intervalMs);

    uint64_t lastScore = 0;
    uint32_t lastStage = 0;
    int32_t lastLives = 0;
    int32_t lastGraze = 0;
    bool first = true;

    for (;;) {
        uint64_t score = 0;
        uint32_t stage = 0;
        int32_t lives = 0;
        int32_t graze = 0;

        if (!SafeRead(base + g_config.scoreRva, &score, sizeof(score))) {
            Log("ScoreMonitor: score address unreadable, monitor disabled");
            return 1;
        }
        SafeRead(base + g_config.stageRva, &stage, sizeof(stage));
        SafeRead(base + g_config.livesRva, &lives, sizeof(lives));
        SafeRead(base + g_config.grazeRva, &graze, sizeof(graze));

        if (first || score != lastScore || stage != lastStage
            || lives != lastLives || graze != lastGraze) {
            SYSTEMTIME st;
            GetSystemTime(&st);
            FILETIME ft;
            SystemTimeToFileTime(&st, &ft);
            ULARGE_INTEGER ui;
            ui.LowPart = ft.dwLowDateTime;
            ui.HighPart = ft.dwHighDateTime;
            // FILETIME(100ns単位, 1601年基点) -> Unix epoch ミリ秒
            unsigned long long epochMs = (ui.QuadPart - 116444736000000000ULL) / 10000ULL;
            Log("ScoreMonitor: score=%llu stage=%u lives=%d graze=%d epoch_ms=%llu",
                (unsigned long long)score, (unsigned)stage, (int)lives, (int)graze, epochMs);
            lastScore = score;
            lastStage = stage;
            lastLives = lives;
            lastGraze = graze;
            first = false;
        }

        Sleep(g_config.intervalMs);
    }
}

} // namespace

void StartScoreMonitorThread(const ScoreMonitorConfig& config) {
    if (!config.scoreRva) return;
    g_config = config;
    CreateThread(NULL, 0, ScoreMonitorThread, NULL, 0, NULL);
}

} // namespace autoplay
