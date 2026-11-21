// DirectSoundの使い方を記録する診断用フック(reports/106)。説明はdsound_probe_hook.hを参照。
#include "dsound_probe_hook.h"
#include "logging.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

namespace autoplay {

namespace {

// ---- 素の型(DirectX SDKヘッダを使わない方針) ----
struct DSBufferDescMin {
    DWORD dwSize;
    DWORD dwFlags;
    DWORD dwBufferBytes;
    DWORD dwReserved;
    void* lpwfxFormat;
};
struct WaveFormatExMin {
    WORD wFormatTag;
    WORD nChannels;
    DWORD nSamplesPerSec;
    DWORD nAvgBytesPerSec;
    WORD nBlockAlign;
    WORD wBitsPerSample;
};
struct PositionNotify {  // DSBPOSITIONNOTIFY
    DWORD dwOffset;
    HANDLE hEventNotify;
};

// IDirectSoundBuffer のvtable
typedef HRESULT(WINAPI* QueryInterface_t)(void*, REFIID, void**);           // [0]
typedef ULONG(WINAPI* Release_t)(void*);                                    // [2]
typedef HRESULT(WINAPI* GetCurrentPosition_t)(void*, DWORD*, DWORD*);       // [4]
typedef HRESULT(WINAPI* GetStatus_t)(void*, DWORD*);                        // [9]
typedef HRESULT(WINAPI* Lock_t)(void*, DWORD, DWORD, void**, DWORD*, void**, DWORD*,
                                DWORD);                                     // [11]
typedef HRESULT(WINAPI* Play_t)(void*, DWORD, DWORD, DWORD);                // [12]
typedef HRESULT(WINAPI* SetCurrentPosition_t)(void*, DWORD);                // [13]
typedef HRESULT(WINAPI* SetVolume_t)(void*, LONG);                          // [15]
typedef HRESULT(WINAPI* SetPan_t)(void*, LONG);                             // [16]
typedef HRESULT(WINAPI* Stop_t)(void*);                                     // [18]
typedef HRESULT(WINAPI* Unlock_t)(void*, void*, DWORD, void*, DWORD);       // [19]
// IDirectSoundNotify のvtable
typedef HRESULT(WINAPI* SetNotificationPositions_t)(void*, DWORD, const PositionNotify*);  // [3]

QueryInterface_t g_origQI = nullptr;
Release_t g_origRelease = nullptr;
GetCurrentPosition_t g_origGetPos = nullptr;
GetStatus_t g_origGetStatus = nullptr;
Lock_t g_origLock = nullptr;
Play_t g_origPlay = nullptr;
SetCurrentPosition_t g_origSetPos = nullptr;
SetVolume_t g_origSetVolume = nullptr;
SetPan_t g_origSetPan = nullptr;
Stop_t g_origStop = nullptr;
Unlock_t g_origUnlock = nullptr;
SetNotificationPositions_t g_origSetNotify = nullptr;

typedef DWORD(WINAPI* WaitForSingleObject_t)(HANDLE, DWORD);
typedef void(WINAPI* Sleep_t)(DWORD);
typedef HANDLE(WINAPI* CreateThread_t)(LPSECURITY_ATTRIBUTES, SIZE_T, LPTHREAD_START_ROUTINE,
                                       LPVOID, DWORD, LPDWORD);
WaitForSingleObject_t g_origWait = nullptr;
Sleep_t g_origSleep = nullptr;
CreateThread_t g_origCreateThread = nullptr;

const GUID kIID_IDirectSoundNotify = {0xb0210783, 0x89cd, 0x11d0,
                                      {0xaf, 0x08, 0x00, 0xa0, 0xc9, 0x25, 0xcd, 0x16}};

CRITICAL_SECTION g_cs;
LONGLONG g_freq = 0, g_t0 = 0;

double NowSec() {
    LARGE_INTEGER t;
    QueryPerformanceCounter(&t);  // このDLL自身のインポート(他のフックの偽装を受けない)
    return (double)(t.QuadPart - g_t0) / (double)g_freq;
}

DWORD ExeRva(void* addr) {
    HMODULE exe = GetModuleHandle(NULL);
    return (DWORD)((BYTE*)addr - (BYTE*)exe);
}

// ---- バッファ ----
enum Method { M_Play, M_Stop, M_Lock, M_Unlock, M_GetPos, M_SetPos, M_SetVol, M_SetPan,
              M_GetStatus, M_Notify, M_Release, M_Count };
const char* kMethodNames[M_Count] = {"Play", "Stop", "Lock", "Unlock", "GetCurrentPosition",
                                     "SetCurrentPosition", "SetVolume", "SetPan", "GetStatus",
                                     "SetNotificationPositions", "Release"};
const int kMaxBuffers = 1024;
const int kDetailPerMethod = 24;

struct BufInfo {
    void* ptr;
    void* notify;  // このバッファから得たIDirectSoundNotify
    DWORD bytes, rate, flags;
    WORD channels, bits;
    LONG detailLeft[M_Count];
    LONG count[M_Count];       // 5秒窓の回数
    LONGLONG lockBytes;        // 5秒窓のLockで要求したバイト数
    LONG totalCount[M_Count];
};
BufInfo g_bufs[kMaxBuffers];
int g_nbufs = 0;

int FindBuf(void* p) {
    for (int i = g_nbufs - 1; i >= 0; i--)
        if (g_bufs[i].ptr == p || g_bufs[i].notify == p) return i;
    return -1;
}

// 通知イベント → (バッファ, 何番目の通知)
const int kMaxEvents = 256;
struct EventInfo {
    HANDLE h;
    int buf, index;
    DWORD offset;
};
EventInfo g_events[kMaxEvents];
int g_nevents = 0;

int FindEvent(HANDLE h) {
    for (int i = 0; i < g_nevents; i++)
        if (g_events[i].h == h) return i;
    return -1;
}

// ---- スレッド ----
const int kMaxThreads = 128;
struct ThrInfo {
    DWORD tid;
    LONG waits, waitTimeouts, sleeps, waitDetailLeft, sleepDetailLeft;
    double waitSec, sleepSec;
    LONG dsCalls;  // 5秒窓のDirectSoundメソッド呼び出し
};
ThrInfo g_thr[kMaxThreads];
int g_nthr = 0;

typedef LONG(NTAPI* NtQueryInformationThread_t)(HANDLE, int, PVOID, ULONG, PULONG);

void DescribeAddress(void* addr, char* out, size_t n) {
    HMODULE mod = nullptr;
    if (addr && GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                                       GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                                   (LPCSTR)addr, &mod) && mod) {
        char path[MAX_PATH] = {0};
        GetModuleFileNameA(mod, path, MAX_PATH);
        const char* base = strrchr(path, '\\');
        _snprintf(out, n, "%s+0x%lX", base ? base + 1 : path,
                  (unsigned long)((BYTE*)addr - (BYTE*)mod));
    } else {
        _snprintf(out, n, "%p", addr);
    }
    out[n - 1] = 0;
}

ThrInfo* CurThread() {
    DWORD tid = GetCurrentThreadId();
    for (int i = 0; i < g_nthr; i++)
        if (g_thr[i].tid == tid) return &g_thr[i];
    if (g_nthr >= kMaxThreads) return nullptr;
    ThrInfo* t = &g_thr[g_nthr++];
    memset(t, 0, sizeof(*t));
    t->tid = tid;
    t->waitDetailLeft = 40;
    t->sleepDetailLeft = 12;
    // 開始アドレス(ThreadQuerySetWin32StartAddress=9)。メインスレッドはexeのエントリポイント。
    void* start = nullptr;
    static NtQueryInformationThread_t q = (NtQueryInformationThread_t)GetProcAddress(
        GetModuleHandleA("ntdll.dll"), "NtQueryInformationThread");
    if (q) q(GetCurrentThread(), 9, &start, sizeof(start), nullptr);
    char desc[160];
    DescribeAddress(start, desc, sizeof(desc));
    Log("DSProbe: thread tid=%lu start=%s t=%.3f", (unsigned long)tid, desc, NowSec());
    return t;
}

// 呼び出しを記録し、詳細を出すべきならtrueを返す。
bool Note(int b, Method m) {
    ThrInfo* t = CurThread();
    if (t) t->dsCalls++;
    if (b < 0) return false;
    g_bufs[b].count[m]++;
    g_bufs[b].totalCount[m]++;
    if (g_bufs[b].detailLeft[m] > 0) {
        g_bufs[b].detailLeft[m]--;
        return true;
    }
    return false;
}

#define CALLER() ExeRva(__builtin_return_address(0))

// ---- バッファのメソッド ----
HRESULT WINAPI MySetNotify(void* p, DWORD count, const PositionNotify* pos);

HRESULT WINAPI MyQI(void* p, REFIID riid, void** out) {
    HRESULT hr = g_origQI(p, riid, out);
    if (SUCCEEDED(hr) && out && *out && IsEqualGUID(riid, kIID_IDirectSoundNotify)) {
        EnterCriticalSection(&g_cs);
        int b = FindBuf(p);
        if (b >= 0) g_bufs[b].notify = *out;
        void** vt = *(void***)(*out);
        Log("DSProbe: #%d QueryInterface(IDirectSoundNotify) -> %p caller=0x%lX", b, *out,
            (unsigned long)CALLER());
        if (!g_origSetNotify) {
            g_origSetNotify = (SetNotificationPositions_t)vt[3];
            DWORD old;
            VirtualProtect(&vt[3], sizeof(void*), PAGE_EXECUTE_READWRITE, &old);
            vt[3] = (void*)MySetNotify;
            VirtualProtect(&vt[3], sizeof(void*), old, &old);
        }
        LeaveCriticalSection(&g_cs);
    }
    return hr;
}

ULONG WINAPI MyRelease(void* p) {
    EnterCriticalSection(&g_cs);
    int b = FindBuf(p);
    LeaveCriticalSection(&g_cs);
    ULONG r = g_origRelease(p);
    if (b >= 0 && g_bufs[b].ptr == p) {
        EnterCriticalSection(&g_cs);
        if (Note(b, M_Release) || r == 0)
            Log("DSProbe: #%d Release -> %lu tid=%lu t=%.3f", b, r,
                (unsigned long)GetCurrentThreadId(), NowSec());
        if (r == 0) g_bufs[b].ptr = (void*)-1;  // 同じアドレスの再利用で取り違えないように
        LeaveCriticalSection(&g_cs);
    }
    return r;
}

HRESULT WINAPI MyGetPos(void* p, DWORD* play, DWORD* write) {
    HRESULT hr = g_origGetPos(p, play, write);
    EnterCriticalSection(&g_cs);
    int b = FindBuf(p);
    if (Note(b, M_GetPos))
        Log("DSProbe: #%d GetCurrentPosition play=%lu write=%lu tid=%lu caller=0x%lX t=%.3f", b,
            play ? (unsigned long)*play : 0, write ? (unsigned long)*write : 0,
            (unsigned long)GetCurrentThreadId(), (unsigned long)CALLER(), NowSec());
    LeaveCriticalSection(&g_cs);
    return hr;
}

HRESULT WINAPI MyGetStatus(void* p, DWORD* st) {
    HRESULT hr = g_origGetStatus(p, st);
    EnterCriticalSection(&g_cs);
    int b = FindBuf(p);
    if (Note(b, M_GetStatus))
        Log("DSProbe: #%d GetStatus -> 0x%lX tid=%lu caller=0x%lX t=%.3f", b,
            st ? (unsigned long)*st : 0, (unsigned long)GetCurrentThreadId(),
            (unsigned long)CALLER(), NowSec());
    LeaveCriticalSection(&g_cs);
    return hr;
}

HRESULT WINAPI MyLock(void* p, DWORD off, DWORD bytes, void** a1, DWORD* n1, void** a2,
                      DWORD* n2, DWORD flags) {
    HRESULT hr = g_origLock(p, off, bytes, a1, n1, a2, n2, flags);
    EnterCriticalSection(&g_cs);
    int b = FindBuf(p);
    if (b >= 0) g_bufs[b].lockBytes += bytes;
    if (Note(b, M_Lock))
        Log("DSProbe: #%d Lock off=%lu bytes=%lu flags=0x%lX hr=0x%08lX tid=%lu caller=0x%lX "
            "t=%.3f", b, (unsigned long)off, (unsigned long)bytes, (unsigned long)flags,
            (unsigned long)hr, (unsigned long)GetCurrentThreadId(), (unsigned long)CALLER(),
            NowSec());
    LeaveCriticalSection(&g_cs);
    return hr;
}

HRESULT WINAPI MyUnlock(void* p, void* a1, DWORD n1, void* a2, DWORD n2) {
    HRESULT hr = g_origUnlock(p, a1, n1, a2, n2);
    EnterCriticalSection(&g_cs);
    int b = FindBuf(p);
    if (Note(b, M_Unlock))
        Log("DSProbe: #%d Unlock n1=%lu n2=%lu tid=%lu t=%.3f", b, (unsigned long)n1,
            (unsigned long)n2, (unsigned long)GetCurrentThreadId(), NowSec());
    LeaveCriticalSection(&g_cs);
    return hr;
}

HRESULT WINAPI MyPlay(void* p, DWORD r1, DWORD prio, DWORD flags) {
    HRESULT hr = g_origPlay(p, r1, prio, flags);
    EnterCriticalSection(&g_cs);
    int b = FindBuf(p);
    if (Note(b, M_Play))
        Log("DSProbe: #%d Play flags=0x%lX hr=0x%08lX tid=%lu caller=0x%lX t=%.3f", b,
            (unsigned long)flags, (unsigned long)hr, (unsigned long)GetCurrentThreadId(),
            (unsigned long)CALLER(), NowSec());
    LeaveCriticalSection(&g_cs);
    return hr;
}

HRESULT WINAPI MySetPos(void* p, DWORD pos) {
    HRESULT hr = g_origSetPos(p, pos);
    EnterCriticalSection(&g_cs);
    int b = FindBuf(p);
    if (Note(b, M_SetPos))
        Log("DSProbe: #%d SetCurrentPosition %lu tid=%lu caller=0x%lX t=%.3f", b,
            (unsigned long)pos, (unsigned long)GetCurrentThreadId(), (unsigned long)CALLER(),
            NowSec());
    LeaveCriticalSection(&g_cs);
    return hr;
}

HRESULT WINAPI MySetVolume(void* p, LONG v) {
    HRESULT hr = g_origSetVolume(p, v);
    EnterCriticalSection(&g_cs);
    int b = FindBuf(p);
    if (Note(b, M_SetVol))
        Log("DSProbe: #%d SetVolume %ld tid=%lu caller=0x%lX t=%.3f", b, v,
            (unsigned long)GetCurrentThreadId(), (unsigned long)CALLER(), NowSec());
    LeaveCriticalSection(&g_cs);
    return hr;
}

HRESULT WINAPI MySetPan(void* p, LONG v) {
    HRESULT hr = g_origSetPan(p, v);
    EnterCriticalSection(&g_cs);
    int b = FindBuf(p);
    if (Note(b, M_SetPan))
        Log("DSProbe: #%d SetPan %ld tid=%lu t=%.3f", b, v, (unsigned long)GetCurrentThreadId(),
            NowSec());
    LeaveCriticalSection(&g_cs);
    return hr;
}

HRESULT WINAPI MyStop(void* p) {
    HRESULT hr = g_origStop(p);
    EnterCriticalSection(&g_cs);
    int b = FindBuf(p);
    if (Note(b, M_Stop))
        Log("DSProbe: #%d Stop tid=%lu caller=0x%lX t=%.3f", b,
            (unsigned long)GetCurrentThreadId(), (unsigned long)CALLER(), NowSec());
    LeaveCriticalSection(&g_cs);
    return hr;
}

void PatchSlot(void** vt, int idx, void* fn, void** orig) {
    if (vt[idx] == fn) return;
    if (!*orig) *orig = vt[idx];
    DWORD old;
    VirtualProtect(&vt[idx], sizeof(void*), PAGE_EXECUTE_READWRITE, &old);
    vt[idx] = fn;
    VirtualProtect(&vt[idx], sizeof(void*), old, &old);
}

void OnBufferCreated(void* buffer, const void* descPtr, bool isPrimary, void* ret) {
    const DSBufferDescMin* desc = (const DSBufferDescMin*)descPtr;
    EnterCriticalSection(&g_cs);
    CurThread();
    int b = -1;
    if (g_nbufs < kMaxBuffers) {
        b = g_nbufs++;
        BufInfo& bi = g_bufs[b];
        memset(&bi, 0, sizeof(bi));
        bi.ptr = buffer;
        bi.flags = desc ? desc->dwFlags : 0;
        bi.bytes = desc ? desc->dwBufferBytes : 0;
        if (desc && desc->lpwfxFormat) {
            const WaveFormatExMin* wf = (const WaveFormatExMin*)desc->lpwfxFormat;
            bi.rate = wf->nSamplesPerSec;
            bi.channels = wf->nChannels;
            bi.bits = wf->wBitsPerSample;
        }
        for (int m = 0; m < M_Count; m++) bi.detailLeft[m] = kDetailPerMethod;
    }
    Log("DSProbe: buffer #%d created %s ptr=%p flags=0x%lX bytes=%lu rate=%lu ch=%u bits=%u "
        "(%.3fs) tid=%lu caller=0x%lX t=%.3f",
        b, isPrimary ? "PRIMARY" : "secondary", buffer, desc ? (unsigned long)desc->dwFlags : 0,
        b >= 0 ? (unsigned long)g_bufs[b].bytes : 0, b >= 0 ? (unsigned long)g_bufs[b].rate : 0,
        b >= 0 ? g_bufs[b].channels : 0, b >= 0 ? g_bufs[b].bits : 0,
        (b >= 0 && g_bufs[b].rate) ? (double)g_bufs[b].bytes / (g_bufs[b].rate * g_bufs[b].channels *
                                                                  (g_bufs[b].bits / 8))
                                   : 0.0,
        (unsigned long)GetCurrentThreadId(), (unsigned long)ExeRva(ret), NowSec());
    if (!isPrimary) {
        void** vt = *(void***)buffer;
        PatchSlot(vt, 0, (void*)MyQI, (void**)&g_origQI);
        PatchSlot(vt, 2, (void*)MyRelease, (void**)&g_origRelease);
        PatchSlot(vt, 4, (void*)MyGetPos, (void**)&g_origGetPos);
        PatchSlot(vt, 9, (void*)MyGetStatus, (void**)&g_origGetStatus);
        PatchSlot(vt, 11, (void*)MyLock, (void**)&g_origLock);
        PatchSlot(vt, 12, (void*)MyPlay, (void**)&g_origPlay);
        PatchSlot(vt, 13, (void*)MySetPos, (void**)&g_origSetPos);
        PatchSlot(vt, 15, (void*)MySetVolume, (void**)&g_origSetVolume);
        PatchSlot(vt, 16, (void*)MySetPan, (void**)&g_origSetPan);
        PatchSlot(vt, 18, (void*)MyStop, (void**)&g_origStop);
        PatchSlot(vt, 19, (void*)MyUnlock, (void**)&g_origUnlock);
    }
    LeaveCriticalSection(&g_cs);
}

void OnBufferDuplicated(void* original, void* dup, void* ret) {
    EnterCriticalSection(&g_cs);
    CurThread();
    int src = FindBuf(original);
    int b = -1;
    if (g_nbufs < kMaxBuffers) {
        b = g_nbufs++;
        BufInfo& bi = g_bufs[b];
        if (src >= 0) bi = g_bufs[src];
        else memset(&bi, 0, sizeof(bi));
        bi.ptr = dup;
        bi.notify = nullptr;
        memset(bi.count, 0, sizeof(bi.count));
        memset(bi.totalCount, 0, sizeof(bi.totalCount));
        bi.lockBytes = 0;
        for (int m = 0; m < M_Count; m++) bi.detailLeft[m] = 4;
    }
    Log("DSProbe: buffer #%d DUPLICATED from #%d ptr=%p tid=%lu caller=0x%lX t=%.3f", b, src, dup,
        (unsigned long)GetCurrentThreadId(), (unsigned long)ExeRva(ret), NowSec());
    LeaveCriticalSection(&g_cs);
}

// ---- スレッド・待ち ----
DWORD WINAPI MyWait(HANDLE h, DWORD ms) {
    double t0 = NowSec();
    DWORD r = g_origWait(h, ms);
    double dt = NowSec() - t0;
    EnterCriticalSection(&g_cs);
    ThrInfo* t = CurThread();
    int e = FindEvent(h);
    if (t) {
        t->waits++;
        t->waitSec += dt;
        if (r == WAIT_TIMEOUT) t->waitTimeouts++;
        if (t->waitDetailLeft > 0) {
            t->waitDetailLeft--;
            if (e >= 0)
                Log("DSProbe: wait tid=%lu handle=%p (#%d:%d off=%lu) ms=%ld -> %lu waited=%.4f "
                    "caller=0x%lX t=%.3f", (unsigned long)t->tid, h, g_events[e].buf,
                    g_events[e].index, (unsigned long)g_events[e].offset, (long)ms,
                    (unsigned long)r, dt, (unsigned long)CALLER(), t0);
            else
                Log("DSProbe: wait tid=%lu handle=%p (other) ms=%ld -> %lu waited=%.4f "
                    "caller=0x%lX t=%.3f", (unsigned long)t->tid, h, (long)ms, (unsigned long)r,
                    dt, (unsigned long)CALLER(), t0);
        }
    }
    LeaveCriticalSection(&g_cs);
    return r;
}

void WINAPI MySleep(DWORD ms) {
    double t0 = NowSec();
    g_origSleep(ms);
    double dt = NowSec() - t0;
    EnterCriticalSection(&g_cs);
    ThrInfo* t = CurThread();
    if (t) {
        t->sleeps++;
        t->sleepSec += dt;
        if (t->sleepDetailLeft > 0) {
            t->sleepDetailLeft--;
            Log("DSProbe: sleep tid=%lu ms=%lu slept=%.4f caller=0x%lX t=%.3f",
                (unsigned long)t->tid, (unsigned long)ms, dt, (unsigned long)CALLER(), t0);
        }
    }
    LeaveCriticalSection(&g_cs);
}

HANDLE WINAPI MyCreateThread(LPSECURITY_ATTRIBUTES sa, SIZE_T stack, LPTHREAD_START_ROUTINE fn,
                             LPVOID param, DWORD flags, LPDWORD tidOut) {
    DWORD tid = 0;
    HANDLE h = g_origCreateThread(sa, stack, fn, param, flags, &tid);
    if (tidOut) *tidOut = tid;
    char desc[160];
    DescribeAddress((void*)fn, desc, sizeof(desc));
    Log("DSProbe: CreateThread new_tid=%lu start=%s flags=0x%lX by tid=%lu caller=0x%lX t=%.3f",
        (unsigned long)tid, desc, (unsigned long)flags, (unsigned long)GetCurrentThreadId(),
        (unsigned long)CALLER(), NowSec());
    return h;
}

DWORD WINAPI SummaryThread(LPVOID) {
    for (;;) {
        g_origSleep ? g_origSleep(5000) : Sleep(5000);
        EnterCriticalSection(&g_cs);
        Log("DSProbe: window t=%.1f buffers=%d events=%d threads=%d", NowSec(), g_nbufs,
            g_nevents, g_nthr);
        for (int b = 0; b < g_nbufs; b++) {
            BufInfo& bi = g_bufs[b];
            LONG any = 0;
            for (int m = 0; m < M_Count; m++) any += bi.count[m];
            if (!any) continue;
            char line[512];
            int n = _snprintf(line, sizeof(line), "DSProbe: buf #%d (%lub %luHz)", b,
                              (unsigned long)bi.bytes, (unsigned long)bi.rate);
            for (int m = 0; m < M_Count && n < (int)sizeof(line) - 40; m++)
                if (bi.count[m])
                    n += _snprintf(line + n, sizeof(line) - n, " %s=%ld", kMethodNames[m],
                                   bi.count[m]);
            if (bi.lockBytes && n < (int)sizeof(line) - 40)
                n += _snprintf(line + n, sizeof(line) - n, " lockBytes=%lld", bi.lockBytes);
            line[sizeof(line) - 1] = 0;
            Log("%s", line);
            memset(bi.count, 0, sizeof(bi.count));
            bi.lockBytes = 0;
        }
        for (int i = 0; i < g_nthr; i++) {
            ThrInfo& t = g_thr[i];
            if (!t.waits && !t.sleeps && !t.dsCalls) continue;
            Log("DSProbe: thr %lu waits=%ld timeouts=%ld waitSec=%.3f sleeps=%ld sleepSec=%.3f "
                "dsCalls=%ld", (unsigned long)t.tid, t.waits, t.waitTimeouts, t.waitSec,
                t.sleeps, t.sleepSec, t.dsCalls);
            t.waits = t.waitTimeouts = t.sleeps = t.dsCalls = 0;
            t.waitSec = t.sleepSec = 0;
        }
        LeaveCriticalSection(&g_cs);
    }
    return 0;
}

bool HookIATEntry(const char* dllName, const char* funcName, void* newFunc, void** outOld) {
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

HRESULT WINAPI MySetNotify(void* p, DWORD count, const PositionNotify* pos) {
    HRESULT hr = g_origSetNotify(p, count, pos);
    EnterCriticalSection(&g_cs);
    int b = FindBuf(p);
    Note(b, M_Notify);
    char line[700];
    int n = _snprintf(line, sizeof(line), "DSProbe: notify #%d count=%lu hr=0x%08lX tid=%lu "
                      "caller=0x%lX offsets=", b, (unsigned long)count, (unsigned long)hr,
                      (unsigned long)GetCurrentThreadId(), (unsigned long)CALLER());
    for (DWORD i = 0; i < count && pos; i++) {
        if (n < (int)sizeof(line) - 40)
            n += _snprintf(line + n, sizeof(line) - n, "%lu:%p ", (unsigned long)pos[i].dwOffset,
                           pos[i].hEventNotify);
        if (g_nevents < kMaxEvents && FindEvent(pos[i].hEventNotify) < 0)
            g_events[g_nevents++] = {pos[i].hEventNotify, b, (int)i, pos[i].dwOffset};
    }
    line[sizeof(line) - 1] = 0;
    Log("%s", line);
    LeaveCriticalSection(&g_cs);
    return hr;
}

}  // namespace

bool InstallDSoundProbeHook() {
    const char* env = getenv("DSOUND_PROBE");
    if (!env || atoi(env) == 0) return false;
    InitializeCriticalSection(&g_cs);
    LARGE_INTEGER f, t;
    QueryPerformanceFrequency(&f);
    QueryPerformanceCounter(&t);
    g_freq = f.QuadPart;
    g_t0 = t.QuadPart;
    g_dsoundBufferCreatedCallback = OnBufferCreated;
    g_dsoundBufferDuplicatedCallback = OnBufferDuplicated;
    bool w = HookIATEntry("KERNEL32.dll", "WaitForSingleObject", (void*)MyWait, (void**)&g_origWait);
    bool s = HookIATEntry("KERNEL32.dll", "Sleep", (void*)MySleep, (void**)&g_origSleep);
    bool c = HookIATEntry("KERNEL32.dll", "CreateThread", (void*)MyCreateThread,
                          (void**)&g_origCreateThread);
    Log("DSProbe: installed (WaitForSingleObject %s, Sleep %s, CreateThread %s)", w ? "OK" : "-",
        s ? "OK" : "-", c ? "OK" : "-");
    CreateThread(nullptr, 0, SummaryThread, nullptr, 0, nullptr);
    return true;
}

} // namespace autoplay
