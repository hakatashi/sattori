#include "stage_marker_io.h"
#include "dinput_hook.h"
#include "logging.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

namespace autoplay {

typedef HANDLE(WINAPI* CreateFileA_t)(LPCSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES, DWORD, DWORD, HANDLE);
typedef HANDLE(WINAPI* CreateFileW_t)(LPCWSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES, DWORD, DWORD, HANDLE);
typedef BOOL(WINAPI* ReadFile_t)(HANDLE, LPVOID, DWORD, LPDWORD, LPOVERLAPPED);
typedef BOOL(WINAPI* CloseHandle_t)(HANDLE);

static CreateFileA_t g_origCreateFileA = nullptr;
static CreateFileW_t g_origCreateFileW = nullptr;
static ReadFile_t g_origReadFile = nullptr;
static CloseHandle_t g_origCloseHandle = nullptr;

static char g_targetName[64] = {0};
static LONGLONG g_burstBytes = 1024 * 1024;
static DWORD g_burstGapMs = 500;
static volatile LONG g_armed = 0;

// 対象アーカイブのハンドル(ゲームは同じアーカイブを複数ハンドルで開くことがある)
static const int kMaxTargets = 32;
static HANDLE g_targets[kMaxTargets] = {};
static CRITICAL_SECTION g_cs;

// 進行中のバースト
static bool g_inBurst = false;
static LONGLONG g_burstAccum = 0;
static LONG g_burstReads = 0;
static DWORD g_burstLastTick = 0;
static DWORD g_burstFirstTick = 0;
static unsigned long long g_burstFirstEpochMs = 0;
static LONG g_burstFirstFrame = 0;

static unsigned long long EpochMs() {
    FILETIME ft;
    GetSystemTimeAsFileTime(&ft);
    ULARGE_INTEGER u;
    u.LowPart = ft.dwLowDateTime;
    u.HighPart = ft.dwHighDateTime;
    return (u.QuadPart / 10000ULL) - 11644473600000ULL;
}

static const char* BaseName(const char* path) {
    const char* p = strrchr(path, '\\');
    if (p) return p + 1;
    p = strrchr(path, '/');
    if (p) return p + 1;
    return path;
}

static void RememberIfTarget(HANDLE h, const char* path) {
    if (h == INVALID_HANDLE_VALUE || !path) return;
    if (_stricmp(BaseName(path), g_targetName) != 0) return;
    EnterCriticalSection(&g_cs);
    for (int i = 0; i < kMaxTargets; i++) {
        if (g_targets[i] == NULL || g_targets[i] == h) {
            g_targets[i] = h;
            break;
        }
    }
    LeaveCriticalSection(&g_cs);
}

static bool IsTarget(HANDLE h) {
    for (int i = 0; i < kMaxTargets; i++) {
        if (g_targets[i] == h) return true;
    }
    return false;
}

static HANDLE WINAPI MyCreateFileA(LPCSTR name, DWORD a, DWORD s, LPSECURITY_ATTRIBUTES sa,
                                    DWORD d, DWORD f, HANDLE t) {
    HANDLE h = g_origCreateFileA(name, a, s, sa, d, f, t);
    RememberIfTarget(h, name);
    return h;
}

static HANDLE WINAPI MyCreateFileW(LPCWSTR name, DWORD a, DWORD s, LPSECURITY_ATTRIBUTES sa,
                                    DWORD d, DWORD f, HANDLE t) {
    HANDLE h = g_origCreateFileW(name, a, s, sa, d, f, t);
    if (h != INVALID_HANDLE_VALUE && name) {
        char buf[MAX_PATH] = {0};
        WideCharToMultiByte(CP_ACP, 0, name, -1, buf, sizeof(buf) - 1, NULL, NULL);
        RememberIfTarget(h, buf);
    }
    return h;
}

static BOOL WINAPI MyReadFile(HANDLE h, LPVOID buf, DWORD n, LPDWORD read, LPOVERLAPPED ov) {
    BOOL ok = g_origReadFile(h, buf, n, read, ov);
    if (!g_armed) return ok;
    EnterCriticalSection(&g_cs);
    if (IsTarget(h)) {
        DWORD got = (ok && read) ? *read : 0;
        DWORD now = GetTickCount();
        if (!g_inBurst) {
            g_inBurst = true;
            g_burstAccum = 0;
            g_burstReads = 0;
            g_burstFirstTick = now;
            g_burstFirstEpochMs = EpochMs();
            g_burstFirstFrame = g_hookCallCount;
        }
        g_burstAccum += got;
        g_burstReads++;
        g_burstLastTick = now;
    }
    LeaveCriticalSection(&g_cs);
    return ok;
}

static BOOL WINAPI MyCloseHandle(HANDLE h) {
    EnterCriticalSection(&g_cs);
    for (int i = 0; i < kMaxTargets; i++) {
        if (g_targets[i] == h) g_targets[i] = NULL;
    }
    LeaveCriticalSection(&g_cs);
    return g_origCloseHandle(h);
}

static DWORD WINAPI BurstFlushThread(LPVOID) {
    for (;;) {
        Sleep(100);
        LONGLONG bytes = 0;
        LONG reads = 0;
        unsigned long long epochMs = 0;
        LONG frame = 0;
        bool emit = false;

        EnterCriticalSection(&g_cs);
        if (g_inBurst && GetTickCount() - g_burstLastTick >= g_burstGapMs) {
            bytes = g_burstAccum;
            reads = g_burstReads;
            epochMs = g_burstFirstEpochMs;
            frame = g_burstFirstFrame;
            emit = bytes >= g_burstBytes;
            g_inBurst = false;
        }
        LeaveCriticalSection(&g_cs);

        if (emit) {
            Log("StageMarker: stage_load file=%s bytes=%lld reads=%ld frame=%ld epoch_ms=%llu",
                g_targetName, (long long)bytes, reads, (long)frame, epochMs);
        }
    }
    return 0;
}

static bool HookIATEntry(const char* dllName, const char* funcName, void* newFunc,
                          void** outOld) {
    HMODULE hExe = GetModuleHandle(NULL);
    BYTE* base = (BYTE*)hExe;
    auto* dos = (IMAGE_DOS_HEADER*)base;
    auto* nt = (IMAGE_NT_HEADERS*)(base + dos->e_lfanew);
    auto& dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (dir.VirtualAddress == 0) return false;
    auto* imp = (IMAGE_IMPORT_DESCRIPTOR*)(base + dir.VirtualAddress);

    for (; imp->Name; imp++) {
        if (_stricmp((char*)(base + imp->Name), dllName) != 0) continue;
        auto* thunk = (IMAGE_THUNK_DATA*)(base + imp->FirstThunk);
        auto* ithunk = (IMAGE_THUNK_DATA*)(base + imp->OriginalFirstThunk);
        for (; thunk->u1.Function; thunk++, ithunk++) {
            if (IMAGE_SNAP_BY_ORDINAL(ithunk->u1.Ordinal)) continue;
            auto* byName = (IMAGE_IMPORT_BY_NAME*)(base + ithunk->u1.AddressOfData);
            if (_stricmp((char*)byName->Name, funcName) != 0) continue;
            DWORD oldProt;
            VirtualProtect(&thunk->u1.Function, sizeof(void*), PAGE_EXECUTE_READWRITE, &oldProt);
            if (outOld) *outOld = (void*)thunk->u1.Function;
            thunk->u1.Function = (ULONG_PTR)newFunc;
            VirtualProtect(&thunk->u1.Function, sizeof(void*), oldProt, &oldProt);
            return true;
        }
    }
    return false;
}

void ArmStageMarkerIo() {
    InterlockedExchange(&g_armed, 1);
    Log("ArmStageMarkerIo: ステージロード検出を有効化しました");
}

bool InstallStageMarkerIoHook(const char* dataFileName, LONGLONG burstBytes, DWORD burstGapMs) {
    if (!dataFileName || !*dataFileName) return false;
    strncpy(g_targetName, dataFileName, sizeof(g_targetName) - 1);
    g_targetName[sizeof(g_targetName) - 1] = '\0';
    g_burstBytes = burstBytes;
    g_burstGapMs = burstGapMs;
    InitializeCriticalSection(&g_cs);

    bool a = HookIATEntry("KERNEL32.dll", "CreateFileA", (void*)MyCreateFileA,
                           (void**)&g_origCreateFileA);
    bool w = HookIATEntry("KERNEL32.dll", "CreateFileW", (void*)MyCreateFileW,
                           (void**)&g_origCreateFileW);
    bool rd = HookIATEntry("KERNEL32.dll", "ReadFile", (void*)MyReadFile, (void**)&g_origReadFile);
    bool ch = HookIATEntry("KERNEL32.dll", "CloseHandle", (void*)MyCloseHandle,
                            (void**)&g_origCloseHandle);
    Log("InstallStageMarkerIoHook: file=%s burstBytes=%lld gapMs=%lu "
        "(CreateFileA=%d CreateFileW=%d ReadFile=%d CloseHandle=%d)",
        g_targetName, (long long)burstBytes, (unsigned long)burstGapMs, a, w, rd, ch);
    if (!rd) return false;
    CreateThread(NULL, 0, BurstFlushThread, NULL, 0, NULL);
    return true;
}

} // namespace autoplay
