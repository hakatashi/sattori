#include "score_probe_hook.h"
#include "logging.h"
#include <stdlib.h>
#include <string.h>

namespace autoplay {

namespace {

DWORD EnvInt(const char* name, DWORD def) {
    char buf[32];
    DWORD n = GetEnvironmentVariableA(name, buf, sizeof(buf));
    if (n == 0 || n >= sizeof(buf)) return def;
    return (DWORD)strtoul(buf, NULL, 0);
}

struct Slot {
    uint32_t last;
    uint32_t maxVal;
    uint32_t minVal;
    bool everChanged;
    bool disqualified; // 一度でも減少したら失格
};

DWORD WINAPI ScoreProbeThread(LPVOID) {
    uintptr_t moduleBase = (uintptr_t)GetModuleHandleA(NULL);
    if (!moduleBase) return 1;

    uint32_t rvaStart = EnvInt("SCORE_PROBE_RVA_START", 0x00200000);
    uint32_t rvaEnd = EnvInt("SCORE_PROBE_RVA_END", 0x00240000);
    DWORD intervalMs = EnvInt("SCORE_PROBE_INTERVAL_MS", 500);
    int totalSamples = (int)EnvInt("SCORE_PROBE_SAMPLES", 40);
    uint32_t minValue = EnvInt("SCORE_PROBE_MIN_VALUE", 1000);
    uint32_t maxValue = EnvInt("SCORE_PROBE_MAX_VALUE", 100000000);

    SIZE_T count = (rvaEnd - rvaStart) / 4;
    Slot* slots = (Slot*)malloc(sizeof(Slot) * count);
    if (!slots) return 1;
    memset(slots, 0, sizeof(Slot) * count);

    Log("ScoreProbe: started rva=[0x%08X..0x%08X) count=%lu interval=%lums samples=%d "
        "value_range=[%u..%u]",
        rvaStart, rvaEnd, (unsigned long)count, (unsigned long)intervalMs, totalSamples,
        minValue, maxValue);

    for (int sample = 0; sample < totalSamples; sample++) {
        Sleep(intervalMs);
        const uint32_t* base = (const uint32_t*)(moduleBase + rvaStart);
        for (SIZE_T i = 0; i < count; i++) {
            Slot& s = slots[i];
            if (s.disqualified) continue;
            uint32_t v = base[i];
            if (sample == 0) {
                s.last = v;
                s.minVal = v;
                s.maxVal = v;
                continue;
            }
            if (v != s.last) s.everChanged = true;
            if (v < s.last) {
                s.disqualified = true;
                continue;
            }
            s.last = v;
            if (v > s.maxVal) s.maxVal = v;
            if (v < s.minVal) s.minVal = v;
        }
    }

    int reported = 0;
    for (SIZE_T i = 0; i < count; i++) {
        Slot& s = slots[i];
        if (s.disqualified || !s.everChanged) continue;
        if (s.last < minValue || s.last > maxValue) continue;
        uint32_t rva = rvaStart + (uint32_t)(i * 4);
        Log("ScoreProbe: CANDIDATE rva=0x%08X final=%u min=%u max=%u",
            rva, s.last, s.minVal, s.maxVal);
        reported++;
        if (reported >= 200) {
            Log("ScoreProbe: candidate count exceeded 200, stopping report (loosen filters)");
            break;
        }
    }
    Log("ScoreProbe: done, %d candidate(s) reported", reported);

    free(slots);
    return 0;
}

} // namespace

void InstallScoreProbeHook() {
    char buf[8];
    if (GetEnvironmentVariableA("SCORE_PROBE", buf, sizeof(buf)) == 0) return;
    CreateThread(NULL, 0, ScoreProbeThread, NULL, 0, NULL);
}

} // namespace autoplay
