#include "score_monitor.h"
#include "logging.h"
#include <string.h>

namespace autoplay {

namespace {

ScoreMonitorConfig g_config;

// 指定アドレスが実際に読める(コミット済みの)ページかを確認してから読む。
// 想定外バイナリにRVAを指定した場合や、th07/th08のようにポインタが
// まだ初期化されていない(メニュー中等)場合にアクセス違反でゲームごと
// 落とさないための保険。
bool SafeReadRaw(uintptr_t addr, void* out, SIZE_T size) {
    if (!addr) return false;
    MEMORY_BASIC_INFORMATION mbi;
    if (VirtualQuery((LPCVOID)addr, &mbi, sizeof(mbi)) != sizeof(mbi)) return false;
    if (mbi.State != MEM_COMMIT) return false;
    if (mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD)) return false;
    if ((uintptr_t)mbi.BaseAddress + mbi.RegionSize < addr + size) return false;
    memcpy(out, (const void*)addr, size);
    return true;
}

// widthバイトの符号なし整数として読む(スコア用)。
bool ReadUnsigned(uintptr_t addr, uint8_t width, uint64_t* out) {
    switch (width) {
        case 1: { uint8_t v; if (!SafeReadRaw(addr, &v, 1)) return false; *out = v; return true; }
        case 2: { uint16_t v; if (!SafeReadRaw(addr, &v, 2)) return false; *out = v; return true; }
        case 4: { uint32_t v; if (!SafeReadRaw(addr, &v, 4)) return false; *out = v; return true; }
        case 8: { uint64_t v; if (!SafeReadRaw(addr, &v, 8)) return false; *out = v; return true; }
        default: return false;
    }
}

// widthバイトの符号付き整数(またはfloat)として読む(ステージ/残機/グレイズ用)。
bool ReadSigned(uintptr_t addr, uint8_t width, bool isFloat, int32_t* out) {
    if (width == 0) return false;
    if (isFloat) {
        if (width != 4) return false;
        float v;
        if (!SafeReadRaw(addr, &v, 4)) return false;
        *out = (int32_t)v;
        return true;
    }
    switch (width) {
        case 1: { int8_t v; if (!SafeReadRaw(addr, &v, 1)) return false; *out = v; return true; }
        case 2: { int16_t v; if (!SafeReadRaw(addr, &v, 2)) return false; *out = v; return true; }
        case 4: { int32_t v; if (!SafeReadRaw(addr, &v, 4)) return false; *out = v; return true; }
        default: return false;
    }
}

// baseIsPointer に従って状態構造体の基点アドレスを解決する。
// ポインタがまだ0(未初期化)の場合はfalseを返す(異常ではなく、
// リプレイ開始前の一時的な状態として扱う)。
bool ResolveBase(uintptr_t moduleBase, uintptr_t* out) {
    uintptr_t addr = moduleBase + g_config.baseRva;
    if (!g_config.baseIsPointer) {
        *out = addr;
        return true;
    }
    uintptr_t ptr = 0;
    if (!SafeReadRaw(addr, &ptr, sizeof(ptr))) return false;
    if (!ptr) return false;
    *out = ptr;
    return true;
}

DWORD WINAPI ScoreMonitorThread(LPVOID) {
    uintptr_t moduleBase = (uintptr_t)GetModuleHandleA(NULL);
    if (!moduleBase) {
        Log("ScoreMonitor: GetModuleHandleA(NULL) failed, monitor disabled");
        return 1;
    }
    Log("ScoreMonitor: started (module_base=0x%08X base_rva=0x%08X base_is_pointer=%d "
        "score_offset=0x%08X score_width=%u interval=%lums)",
        (unsigned)moduleBase, g_config.baseRva, (int)g_config.baseIsPointer,
        g_config.scoreOffset, (unsigned)g_config.scoreWidth,
        (unsigned long)g_config.intervalMs);

    uint64_t lastScore = 0;
    int32_t lastStage = 0;
    int32_t lastLives = 0;
    int32_t lastGraze = 0;
    bool first = true;

    for (;;) {
        uintptr_t base = 0;
        if (ResolveBase(moduleBase, &base)) {
            uint64_t score = 0;
            if (ReadUnsigned(base + g_config.scoreOffset, g_config.scoreWidth, &score)) {
                int32_t stage = 0, lives = 0, graze = 0;
                ReadSigned(base + g_config.stageOffset, g_config.stageWidth, false, &stage);
                ReadSigned(base + g_config.livesOffset, g_config.livesWidth, g_config.livesIsFloat, &lives);
                ReadSigned(base + g_config.grazeOffset, g_config.grazeWidth, false, &graze);

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
                    Log("ScoreMonitor: score=%llu stage=%d lives=%d graze=%d epoch_ms=%llu",
                        (unsigned long long)score, (int)stage, (int)lives, (int)graze, epochMs);
                    lastScore = score;
                    lastStage = stage;
                    lastLives = lives;
                    lastGraze = graze;
                    first = false;
                }
            }
        }
        // baseが未解決/未初期化の場合(th07/th08でリプレイ開始前にポインタが
        // まだnullな場合等)は、静かにリトライを続ける。一度も読めたことが
        // ないまま長時間経過してもスレッド自体は止めない(タイトルによって
        // メニュー操作に要する時間が異なるため、固定タイムアウトを設けると
        // 遅いタイトルで誤って監視を諦めてしまう)。

        Sleep(g_config.intervalMs);
    }
}

} // namespace

void StartScoreMonitorThread(const ScoreMonitorConfig& config) {
    if (!config.baseRva) return;
    g_config = config;
    CreateThread(NULL, 0, ScoreMonitorThread, NULL, 0, NULL);
}

} // namespace autoplay
