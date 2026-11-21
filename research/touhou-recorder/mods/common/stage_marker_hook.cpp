#include "stage_marker_hook.h"
#include "dinput_hook.h"
#include "logging.h"
#include <stdlib.h>

namespace autoplay {

struct MarkerArgs {
    ULONG_PTR rva;
    int width;
    int stageBase;
    unsigned int pollIntervalMs;
    int maxStage;
};

static unsigned long long EpochMs() {
    FILETIME ft;
    GetSystemTimeAsFileTime(&ft);
    ULARGE_INTEGER u;
    u.LowPart = ft.dwLowDateTime;
    u.HighPart = ft.dwHighDateTime;
    // FILETIMEは1601-01-01からの100ns単位。1601→1970は11644473600秒。
    return (u.QuadPart / 10000ULL) - 11644473600000ULL;
}

static DWORD WINAPI StageMarkerThread(LPVOID param) {
    MarkerArgs args = *(MarkerArgs*)param;
    delete (MarkerArgs*)param;

    BYTE* base = (BYTE*)GetModuleHandle(NULL);
    volatile BYTE* addr = base + args.rva;

    int last = -1;
    for (;;) {
        Sleep(args.pollIntervalMs);
        int value;
        if (args.width == 1) {
            value = (int)*addr;
        } else {
            value = (int)*(volatile DWORD*)addr;
        }
        value += args.stageBase;
        if (value < 0 || value > args.maxStage) continue;
        if (value == last) continue;
        // 起動直後の初期値は「変化」ではないので、1回目は基準として控えるだけにする。
        if (last < 0) {
            last = value;
            Log("StageMarker: baseline stage=%d frame=%ld epoch_ms=%llu", value,
                (long)g_hookCallCount, EpochMs());
            continue;
        }
        Log("StageMarker: stage=%d prev=%d frame=%ld epoch_ms=%llu", value, last,
            (long)g_hookCallCount, EpochMs());
        last = value;
    }
    return 0;
}

struct PatternArgs {
    ULONG_PTR rva;
    unsigned int pollIntervalMs;
    int maxLimit;
};

static DWORD WINAPI PatternMarkerThread(LPVOID param) {
    PatternArgs args = *(PatternArgs*)param;
    delete (PatternArgs*)param;

    BYTE* base = (BYTE*)GetModuleHandle(NULL);
    volatile DWORD* addr = (volatile DWORD*)(base + args.rva);

    DWORD last = *addr;
    for (;;) {
        Sleep(args.pollIntervalMs);
        DWORD value = *addr;
        if (value == last) continue;
        // カウントダウン中の減少は無視し、増加(=リセット)だけを拾う。
        if (value > last && value <= (DWORD)args.maxLimit) {
            Log("StageMarker: pattern limit=%lu prev=%lu frame=%ld epoch_ms=%llu",
                (unsigned long)value, (unsigned long)last, (long)g_hookCallCount, EpochMs());
        }
        last = value;
    }
    return 0;
}

bool InstallPatternMarkerHook(ULONG_PTR rva, unsigned int pollIntervalMs, int maxLimit) {
    const char* env = getenv("PATTERN_MARKER_RVA");
    if (env && *env) rva = (ULONG_PTR)strtoul(env, nullptr, 0);
    if (rva == 0) {
        Log("InstallPatternMarkerHook: RVA未設定のため無効");
        return false;
    }
    PatternArgs* args = new PatternArgs{rva, pollIntervalMs, maxLimit};
    CreateThread(NULL, 0, PatternMarkerThread, args, 0, NULL);
    Log("InstallPatternMarkerHook: rva=0x%08lx pollMs=%u maxLimit=%d",
        (unsigned long)rva, pollIntervalMs, maxLimit);
    return true;
}

struct SpellFlagArgs {
    ULONG_PTR rva;
    unsigned int pollIntervalMs;
};

static DWORD WINAPI SpellFlagThread(LPVOID param) {
    SpellFlagArgs args = *(SpellFlagArgs*)param;
    delete (SpellFlagArgs*)param;

    BYTE* base = (BYTE*)GetModuleHandle(NULL);
    volatile BYTE* addr = base + args.rva;

    BYTE last = *addr;
    for (;;) {
        Sleep(args.pollIntervalMs);
        BYTE value = *addr;
        if (value == last) continue;
        if (value <= 1) {
            Log("StageMarker: spell flag=%d frame=%ld epoch_ms=%llu", (int)value,
                (long)g_hookCallCount, EpochMs());
        }
        last = value;
    }
    return 0;
}

bool InstallSpellFlagMarkerHook(ULONG_PTR rva, unsigned int pollIntervalMs) {
    const char* env = getenv("SPELL_FLAG_RVA");
    if (env && *env) rva = (ULONG_PTR)strtoul(env, nullptr, 0);
    if (rva == 0) {
        Log("InstallSpellFlagMarkerHook: RVA未設定のため無効");
        return false;
    }
    SpellFlagArgs* args = new SpellFlagArgs{rva, pollIntervalMs};
    CreateThread(NULL, 0, SpellFlagThread, args, 0, NULL);
    Log("InstallSpellFlagMarkerHook: rva=0x%08lx pollMs=%u", (unsigned long)rva, pollIntervalMs);
    return true;
}

void LogReplayStartMarker() {
    Log("StageMarker: replay_start frame=%ld epoch_ms=%llu", (long)g_hookCallCount, EpochMs());
}

bool InstallStageMarkerHook(ULONG_PTR rva, int width, int stageBase,
                            unsigned int pollIntervalMs, int maxStage) {
    const char* env = getenv("STAGE_MARKER_RVA");
    if (env && *env) {
        rva = (ULONG_PTR)strtoul(env, nullptr, 0);
    }
    const char* envWidth = getenv("STAGE_MARKER_WIDTH");
    if (envWidth && *envWidth) {
        int w = atoi(envWidth);
        if (w == 1 || w == 4) width = w;
    }
    if (rva == 0) {
        Log("InstallStageMarkerHook: RVA未設定のため無効");
        return false;
    }
    MarkerArgs* args = new MarkerArgs{rva, width, stageBase, pollIntervalMs, maxStage};
    CreateThread(NULL, 0, StageMarkerThread, args, 0, NULL);
    Log("InstallStageMarkerHook: rva=0x%08lx width=%d stageBase=%d pollMs=%u maxStage=%d",
        (unsigned long)rva, width, stageBase, pollIntervalMs, maxStage);
    return true;
}

} // namespace autoplay
