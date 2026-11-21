#include "stage_probe_hook.h"
#include "dinput_hook.h"
#include "logging.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

namespace autoplay {

// ---------------------------------------------------------------------------
// 共通: IATフックユーティリティ(他のフックと同じ実装)
// ---------------------------------------------------------------------------

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

// フック内からLog()を呼ぶとCRTのfopen/fwriteが再びファイルAPIを呼び、
// 無限再帰する恐れがあるためスレッドごとのガードを持つ。
static __thread int g_reentry = 0;
struct ReentryGuard {
    bool ok;
    ReentryGuard() : ok(g_reentry == 0) { g_reentry++; }
    ~ReentryGuard() { g_reentry--; }
};

static DWORD g_t0 = 0;
static double ElapsedSec() { return (GetTickCount() - g_t0) / 1000.0; }

// ---------------------------------------------------------------------------
// (A) ファイルI/O観測
// ---------------------------------------------------------------------------

static const int kMaxHandles = 128;

struct HandleInfo {
    HANDLE h;
    char name[64];
    LONGLONG pos;        // 自前で追跡する現在位置
    // 集計ウィンドウ内の統計
    LONG readCount;
    LONGLONG readBytes;
    LONGLONG firstOffset;
    LONGLONG lastOffset;
    LONG seekCount;
    bool dirty;
};

static HandleInfo g_handles[kMaxHandles] = {};
static CRITICAL_SECTION g_ioCs;

static const char* BaseName(const char* path) {
    const char* p = strrchr(path, '\\');
    if (p) return p + 1;
    p = strrchr(path, '/');
    if (p) return p + 1;
    return path;
}

static void RegisterHandle(HANDLE h, const char* path) {
    if (h == INVALID_HANDLE_VALUE) return;
    EnterCriticalSection(&g_ioCs);
    int slot = -1;
    for (int i = 0; i < kMaxHandles; i++) {
        if (g_handles[i].h == h) { slot = i; break; }
        if (slot < 0 && g_handles[i].h == NULL) slot = i;
    }
    if (slot >= 0) {
        memset(&g_handles[slot], 0, sizeof(HandleInfo));
        g_handles[slot].h = h;
        _snprintf_s(g_handles[slot].name, sizeof(g_handles[slot].name), _TRUNCATE, "%s",
                    BaseName(path));
    }
    LeaveCriticalSection(&g_ioCs);
}

static HandleInfo* FindHandle(HANDLE h) {
    for (int i = 0; i < kMaxHandles; i++) {
        if (g_handles[i].h == h) return &g_handles[i];
    }
    return nullptr;
}

typedef HANDLE(WINAPI* CreateFileA_t)(LPCSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES, DWORD, DWORD, HANDLE);
typedef HANDLE(WINAPI* CreateFileW_t)(LPCWSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES, DWORD, DWORD, HANDLE);
typedef BOOL(WINAPI* ReadFile_t)(HANDLE, LPVOID, DWORD, LPDWORD, LPOVERLAPPED);
typedef DWORD(WINAPI* SetFilePointer_t)(HANDLE, LONG, PLONG, DWORD);
typedef BOOL(WINAPI* SetFilePointerEx_t)(HANDLE, LARGE_INTEGER, PLARGE_INTEGER, DWORD);
typedef BOOL(WINAPI* CloseHandle_t)(HANDLE);

static CreateFileA_t g_origCreateFileA = nullptr;
static CreateFileW_t g_origCreateFileW = nullptr;
static ReadFile_t g_origReadFile = nullptr;
static SetFilePointer_t g_origSetFilePointer = nullptr;
static SetFilePointerEx_t g_origSetFilePointerEx = nullptr;
static CloseHandle_t g_origCloseHandle = nullptr;

static HANDLE WINAPI MyCreateFileA(LPCSTR name, DWORD access, DWORD share,
                                    LPSECURITY_ATTRIBUTES sa, DWORD disp, DWORD flags, HANDLE tmpl) {
    HANDLE h = g_origCreateFileA(name, access, share, sa, disp, flags, tmpl);
    ReentryGuard g;
    if (g.ok && name && h != INVALID_HANDLE_VALUE) {
        RegisterHandle(h, name);
        Log("StageProbe: IO open t=%.3f frame=%ld name=%s", ElapsedSec(),
            (long)g_hookCallCount, BaseName(name));
    }
    return h;
}

static HANDLE WINAPI MyCreateFileW(LPCWSTR name, DWORD access, DWORD share,
                                    LPSECURITY_ATTRIBUTES sa, DWORD disp, DWORD flags, HANDLE tmpl) {
    HANDLE h = g_origCreateFileW(name, access, share, sa, disp, flags, tmpl);
    ReentryGuard g;
    if (g.ok && name && h != INVALID_HANDLE_VALUE) {
        char buf[MAX_PATH] = {0};
        WideCharToMultiByte(CP_ACP, 0, name, -1, buf, sizeof(buf) - 1, NULL, NULL);
        RegisterHandle(h, buf);
        Log("StageProbe: IO open t=%.3f frame=%ld name=%s", ElapsedSec(),
            (long)g_hookCallCount, BaseName(buf));
    }
    return h;
}

static BOOL WINAPI MyReadFile(HANDLE h, LPVOID buf, DWORD n, LPDWORD read, LPOVERLAPPED ov) {
    BOOL ok = g_origReadFile(h, buf, n, read, ov);
    // ここではログを書かない(集計のみ)。ログ出力は報告スレッドが行う。
    EnterCriticalSection(&g_ioCs);
    HandleInfo* hi = FindHandle(h);
    if (hi) {
        DWORD got = (ok && read) ? *read : 0;
        if (hi->readCount == 0) hi->firstOffset = hi->pos;
        hi->readCount++;
        hi->readBytes += got;
        hi->lastOffset = hi->pos;
        hi->pos += got;
        hi->dirty = true;
    }
    LeaveCriticalSection(&g_ioCs);
    return ok;
}

static DWORD WINAPI MySetFilePointer(HANDLE h, LONG lo, PLONG hi32, DWORD method) {
    DWORD r = g_origSetFilePointer(h, lo, hi32, method);
    EnterCriticalSection(&g_ioCs);
    HandleInfo* hi = FindHandle(h);
    if (hi && r != INVALID_SET_FILE_POINTER) {
        LONGLONG p = (LONGLONG)r;
        if (hi32) p |= ((LONGLONG)*hi32) << 32;
        hi->pos = p;
        hi->seekCount++;
        hi->dirty = true;
    }
    LeaveCriticalSection(&g_ioCs);
    return r;
}

static BOOL WINAPI MySetFilePointerEx(HANDLE h, LARGE_INTEGER dist, PLARGE_INTEGER newPos, DWORD method) {
    LARGE_INTEGER np = {};
    BOOL ok = g_origSetFilePointerEx(h, dist, &np, method);
    if (newPos) *newPos = np;
    EnterCriticalSection(&g_ioCs);
    HandleInfo* hi = FindHandle(h);
    if (hi && ok) {
        hi->pos = np.QuadPart;
        hi->seekCount++;
        hi->dirty = true;
    }
    LeaveCriticalSection(&g_ioCs);
    return ok;
}

static BOOL WINAPI MyCloseHandle(HANDLE h) {
    EnterCriticalSection(&g_ioCs);
    HandleInfo* hi = FindHandle(h);
    if (hi) hi->h = NULL;
    LeaveCriticalSection(&g_ioCs);
    return g_origCloseHandle(h);
}

static DWORD g_ioReportIntervalMs = 250;

static DWORD WINAPI IoReportThread(LPVOID) {
    for (;;) {
        Sleep(g_ioReportIntervalMs);
        HandleInfo snap[kMaxHandles];
        int n = 0;
        EnterCriticalSection(&g_ioCs);
        for (int i = 0; i < kMaxHandles; i++) {
            if (g_handles[i].dirty) {
                snap[n++] = g_handles[i];
                g_handles[i].readCount = 0;
                g_handles[i].readBytes = 0;
                g_handles[i].seekCount = 0;
                g_handles[i].dirty = false;
            }
        }
        LeaveCriticalSection(&g_ioCs);
        ReentryGuard g;
        if (!g.ok) continue;
        for (int i = 0; i < n; i++) {
            Log("StageProbe: IO t=%.3f frame=%ld file=%s reads=%ld bytes=%lld seeks=%ld "
                "off_first=%lld off_last=%lld",
                ElapsedSec(), (long)g_hookCallCount, snap[i].name, snap[i].readCount,
                (long long)snap[i].readBytes, snap[i].seekCount,
                (long long)snap[i].firstOffset, (long long)snap[i].lastOffset);
        }
    }
    return 0;
}

// ---------------------------------------------------------------------------
// (B) メモリ差分スキャン
// ---------------------------------------------------------------------------

struct ScanRegion {
    BYTE* base;
    SIZE_T size;
    BYTE* shadow;    // 前回スナップショット
    BYTE* changes;   // 変化回数(255で飽和)
    // カウンタ検出モード(STAGE_PROBE_COUNTER)用。4バイト単位の要素ごとに、
    // 直近の変化方向(+1/-1/0)と、その方向が何スキャン連続したかを保持する。
    signed char* dir;
    BYTE* run;
    bool isImage;
};

static const int kMaxRegions = 512;
static ScanRegion g_regions[kMaxRegions];
static int g_regionCount = 0;
static SIZE_T g_totalScan = 0;

static SIZE_T g_maxScanBytes = 16ull * 1024 * 1024;
// 1領域あたりの上限。これを超える巨大なMEM_PRIVATE領域はスキャンしない。
// 初回試行(上限64MB・領域サイズ無制限)ではリプレイ開始と同時にth07が事実上
// フリーズした。巨大領域にはwined3d/llvmpipeのフレームバッファやアセット
// バッファ等、読み出し自体が極端に遅い(あるいはゲーム側と激しく競合する)
// メモリが含まれるためと考えられる。ステージ番号のような制御変数はexeの
// .dataか小さめのヒープブロックにあるはずなので、この制限で十分。
static SIZE_T g_maxRegionBytes = 4ull * 1024 * 1024;
static int g_imageOnly = 0;
static DWORD g_scanIntervalMs = 250;
static int g_maxChanges = 12;
static int g_maxValue = 20;
// ウォームアップ期間(秒)。この間は一切ログを出さず変化回数だけを蓄積する。
// 毎フレーム変わるような雑多な変数はこの間に変化回数が飽和(255)して恒久的に
// 除外されるため、ウォームアップ後は「めったに変化しない変数」だけが残る。
// これを入れないと、起動直後にノイズ変数がmaxChanges回ぶんログを吐き大量の
// ログI/Oでゲーム本体が処理落ちする。
static double g_warmupSec = 90.0;
static int g_strict = 1;
// カウンタ検出モード: 一定方向に増え(減り)続けていた4バイト値が反転した瞬間を記録する。
// 弾幕パターンの制限時間タイマーやパターン内フレームカウンタは、パターンが切り替わる
// たびにリセットされるため、この「反転」がそのままパターン開始の合図になる。
static int g_counterMode = 0;
static int g_counterMinRun = 8;      // 反転を報告するのに必要な連続同方向スキャン数
static LONGLONG g_counterMaxDelta = 100000;  // 1スキャンでこれ以上動く値はカウンタとみなさない

// 自分自身のシャドウ領域をスキャン対象にしないための記録
static void* g_ownAllocs[kMaxRegions * 2];
static int g_ownAllocCount = 0;

static bool IsOwnAlloc(void* p) {
    for (int i = 0; i < g_ownAllocCount; i++) {
        if (g_ownAllocs[i] == p) return true;
    }
    return false;
}

static bool IsWritable(DWORD prot) {
    if (prot & PAGE_GUARD) return false;
    DWORD base = prot & 0xFF;
    return base == PAGE_READWRITE || base == PAGE_WRITECOPY ||
           base == PAGE_EXECUTE_READWRITE || base == PAGE_EXECUTE_WRITECOPY;
}

// 1回のスキャンで一気に触る単位。大きな領域はこのサイズに分割して登録する。
// th08(.dataが20MB)で領域を丸ごと1単位として扱うと、リプレイ開始と同時に
// ゲームがフリーズした(th07の.data 14.8MBでは起きなかった)。分割しておくと
// スキャン直前にチャンクごとVirtualQueryで到達可能性を再確認でき、ゲーム側が
// 途中でプロテクトを変更した領域を安全にスキップできる。
static const SIZE_T kChunkBytes = 1024 * 1024;

static bool AddRegionChunked(BYTE* base, SIZE_T size, bool isImage);

static bool AddRegion(BYTE* base, SIZE_T size, bool isImage) {
    if (g_regionCount >= kMaxRegions) return false;
    if (g_totalScan + size > g_maxScanBytes) return false;
    BYTE* shadow = (BYTE*)VirtualAlloc(NULL, size, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!shadow) return false;
    BYTE* changes = (BYTE*)VirtualAlloc(NULL, size, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!changes) { VirtualFree(shadow, 0, MEM_RELEASE); return false; }
    signed char* dirArr = nullptr;
    BYTE* runArr = nullptr;
    if (g_counterMode) {
        dirArr = (signed char*)VirtualAlloc(NULL, size / 4 + 4, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        runArr = (BYTE*)VirtualAlloc(NULL, size / 4 + 4, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        if (!dirArr || !runArr) {
            if (dirArr) VirtualFree(dirArr, 0, MEM_RELEASE);
            if (runArr) VirtualFree(runArr, 0, MEM_RELEASE);
            VirtualFree(shadow, 0, MEM_RELEASE);
            VirtualFree(changes, 0, MEM_RELEASE);
            return false;
        }
        if (g_ownAllocCount + 2 <= (int)(sizeof(g_ownAllocs) / sizeof(g_ownAllocs[0]))) {
            g_ownAllocs[g_ownAllocCount++] = dirArr;
            g_ownAllocs[g_ownAllocCount++] = runArr;
        }
    }
    if (g_ownAllocCount + 2 <= (int)(sizeof(g_ownAllocs) / sizeof(g_ownAllocs[0]))) {
        g_ownAllocs[g_ownAllocCount++] = shadow;
        g_ownAllocs[g_ownAllocCount++] = changes;
    }
    memcpy(shadow, base, size);
    g_regions[g_regionCount].base = base;
    g_regions[g_regionCount].size = size;
    g_regions[g_regionCount].shadow = shadow;
    g_regions[g_regionCount].changes = changes;
    g_regions[g_regionCount].dir = dirArr;
    g_regions[g_regionCount].run = runArr;
    g_regions[g_regionCount].isImage = isImage;
    g_regionCount++;
    g_totalScan += size;
    return true;
}

static bool AddRegionChunked(BYTE* base, SIZE_T size, bool isImage) {
    SIZE_T done = 0;
    while (done < size) {
        SIZE_T chunk = size - done;
        if (chunk > kChunkBytes) chunk = kChunkBytes;
        if (!AddRegion(base + done, chunk, isImage)) return done > 0;
        done += chunk;
    }
    return true;
}

// スキャン直前に、そのチャンクが今も読める状態かを確認する。
static bool ChunkReadable(BYTE* base, SIZE_T size) {
    MEMORY_BASIC_INFORMATION mbi;
    if (VirtualQuery(base, &mbi, sizeof(mbi)) != sizeof(mbi)) return false;
    if (mbi.State != MEM_COMMIT) return false;
    if (!IsWritable(mbi.Protect)) return false;
    BYTE* end = (BYTE*)mbi.BaseAddress + mbi.RegionSize;
    return base + size <= end;
}

static bool AlreadyTracked(BYTE* base) {
    for (int i = 0; i < g_regionCount; i++) {
        if (g_regions[i].base == base) return true;
    }
    return false;
}

// imageOnly=true なら メインモジュール(exe)のイメージ領域だけを対象にする。
static void EnumerateRegions(bool imageOnly) {
    HMODULE hExe = GetModuleHandle(NULL);
    BYTE* addr = (BYTE*)0x00010000;
    MEMORY_BASIC_INFORMATION mbi;
    while (addr < (BYTE*)0x7FFE0000 && VirtualQuery(addr, &mbi, sizeof(mbi)) == sizeof(mbi)) {
        BYTE* next = (BYTE*)mbi.BaseAddress + mbi.RegionSize;
        if (next <= addr) break;
        bool isImage = (mbi.Type == MEM_IMAGE);
        bool isMainImage = isImage && (BYTE*)mbi.AllocationBase == (BYTE*)hExe;
        if (mbi.State == MEM_COMMIT && IsWritable(mbi.Protect) &&
            (mbi.Type == MEM_PRIVATE || isImage) &&
            !IsOwnAlloc(mbi.AllocationBase) && !AlreadyTracked((BYTE*)mbi.BaseAddress)) {
            bool want = imageOnly ? isMainImage : (!isMainImage && !g_imageOnly &&
                                                   mbi.RegionSize <= g_maxRegionBytes);
            if (want) AddRegionChunked((BYTE*)mbi.BaseAddress, mbi.RegionSize, isImage);
        }
        addr = next;
    }
}

static void DescribeAddress(BYTE* p, char* out, size_t outSize) {
    HMODULE hExe = GetModuleHandle(NULL);
    MEMORY_BASIC_INFORMATION mbi;
    if (VirtualQuery(p, &mbi, sizeof(mbi)) == sizeof(mbi) && mbi.Type == MEM_IMAGE) {
        char mod[MAX_PATH] = {0};
        GetModuleFileNameA((HMODULE)mbi.AllocationBase, mod, sizeof(mod));
        _snprintf_s(out, outSize, _TRUNCATE, "%s+0x%08lx%s", BaseName(mod),
                    (unsigned long)(p - (BYTE*)mbi.AllocationBase),
                    mbi.AllocationBase == (void*)hExe ? " [exe]" : "");
    } else {
        _snprintf_s(out, outSize, _TRUNCATE, "heap/private");
    }
}

static DWORD WINAPI MemScanThread(LPVOID) {
    // 起動直後はモジュールロード等で領域が激しく動くので少し待つ
    Sleep(3000);
    EnumerateRegions(/*imageOnly=*/true);
    int imageRegions = g_regionCount;
    SIZE_T imageBytes = g_totalScan;
    EnumerateRegions(/*imageOnly=*/false);
    Log("StageProbe: MEM scan start regions=%d (exe-image=%d) total=%lluKB limit=%lluMB interval=%lums",
        g_regionCount, imageRegions, (unsigned long long)(g_totalScan / 1024),
        (unsigned long long)(g_maxScanBytes / (1024 * 1024)), (unsigned long)g_scanIntervalMs);
    (void)imageBytes;
    for (int i = 0; i < g_regionCount; i++) {
        char d[160];
        DescribeAddress(g_regions[i].base, d, sizeof(d));
        Log("StageProbe: MEM region[%d] base=0x%08lx size=%lluKB %s", i,
            (unsigned long)(ULONG_PTR)g_regions[i].base,
            (unsigned long long)(g_regions[i].size / 1024), d);
    }

    DWORD lastEnum = GetTickCount();
    LONG reported = 0;
    bool warmupDone = false;
    DWORD lastStat = GetTickCount();
    for (;;) {
        Sleep(g_scanIntervalMs);
        DWORD scanBegin = GetTickCount();

        // 30秒ごとに新規領域を取り込む(リプレイ開始時に確保されるヒープ対策)
        if (GetTickCount() - lastEnum > 30000) {
            int before = g_regionCount;
            EnumerateRegions(/*imageOnly=*/false);
            if (g_regionCount != before) {
                Log("StageProbe: MEM added %d new regions (total=%d, %lluKB)",
                    g_regionCount - before, g_regionCount,
                    (unsigned long long)(g_totalScan / 1024));
            }
            lastEnum = GetTickCount();
        }

        double t = ElapsedSec();
        LONG frame = g_hookCallCount;
        bool logging = (t >= g_warmupSec);
        if (logging && !warmupDone) {
            warmupDone = true;
            long candidates = 0;
            for (int r = 0; r < g_regionCount; r++) {
                for (SIZE_T k = 0; k < g_regions[r].size; k++) {
                    if (g_regions[r].changes[k] <= (BYTE)g_maxChanges) candidates++;
                }
            }
            Log("StageProbe: MEM warmup done t=%.3f frame=%ld candidates(changes<=%d)=%ld / %lluKB",
                t, (long)frame, g_maxChanges, candidates,
                (unsigned long long)(g_totalScan / 1024));
        }
        for (int r = 0; r < g_regionCount; r++) {
            ScanRegion& reg = g_regions[r];
            if (!ChunkReadable(reg.base, reg.size)) continue;
            if (g_counterMode && reg.dir && reg.run) {
                // バイト単位の差分処理でshadowが更新される前に、4バイト単位の
                // カウンタ反転検出を先に済ませる。
                SIZE_T n4 = reg.size;
                for (SIZE_T j = 0; j + 4 <= n4; j += 4) {
                    DWORD nv = *(DWORD*)(reg.base + j);
                    DWORD ov = *(DWORD*)(reg.shadow + j);
                    if (nv == ov) continue;
                    LONGLONG d = (LONGLONG)nv - (LONGLONG)ov;
                    SIZE_T idx = j / 4;
                    int nd = (d > 0) ? 1 : -1;
                    if (d > g_counterMaxDelta || d < -g_counterMaxDelta) {
                        reg.dir[idx] = 0;
                        reg.run[idx] = 0;
                        continue;
                    }
                    if (reg.dir[idx] == 0) {
                        reg.dir[idx] = (signed char)nd;
                        reg.run[idx] = 1;
                    } else if (reg.dir[idx] == nd) {
                        if (reg.run[idx] < 255) reg.run[idx]++;
                    } else {
                        if (logging && reg.run[idx] >= (BYTE)g_counterMinRun) {
                            char desc[160];
                            DescribeAddress(reg.base + j, desc, sizeof(desc));
                            ReentryGuard g;
                            if (g.ok) {
                                Log("StageProbe: COUNTER t=%.3f frame=%ld addr=0x%08lx (%s) "
                                    "%lu->%lu dir=%d run=%d",
                                    t, (long)frame, (unsigned long)(ULONG_PTR)(reg.base + j),
                                    desc, (unsigned long)ov, (unsigned long)nv,
                                    (int)reg.dir[idx], (int)reg.run[idx]);
                            }
                        }
                        reg.dir[idx] = (signed char)nd;
                        reg.run[idx] = 1;
                    }
                }
            }
            SIZE_T i = 0;
            SIZE_T n = reg.size;
            // 4バイト単位で高速比較し、違う場所だけバイト単位で調べる
            for (; i + 4 <= n; i += 4) {
                if (*(DWORD*)(reg.base + i) == *(DWORD*)(reg.shadow + i)) continue;
                for (SIZE_T k = i; k < i + 4; k++) {
                    BYTE nv = reg.base[k];
                    BYTE ov = reg.shadow[k];
                    if (nv == ov) continue;
                    if (reg.changes[k] < 255) reg.changes[k]++;
                    bool match = logging && reg.changes[k] <= (BYTE)g_maxChanges &&
                                 (!g_strict || (nv == (BYTE)(ov + 1) && nv <= (BYTE)g_maxValue));
                    if (match) {
                        char desc[160];
                        DescribeAddress(reg.base + k, desc, sizeof(desc));
                        ReentryGuard g;
                        if (g.ok) {
                            Log("StageProbe: MEM t=%.3f frame=%ld addr=0x%08lx (%s) %d->%d changes=%d",
                                t, (long)frame, (unsigned long)(ULONG_PTR)(reg.base + k), desc,
                                (int)ov, (int)nv, (int)reg.changes[k]);
                            reported++;
                        }
                    }
                    reg.shadow[k] = nv;
                }
            }
            for (; i < n; i++) {
                BYTE nv = reg.base[i];
                if (nv != reg.shadow[i]) {
                    if (reg.changes[i] < 255) reg.changes[i]++;
                    reg.shadow[i] = nv;
                }
            }
        }
        if (GetTickCount() - lastStat > 30000) {
            ReentryGuard g;
            if (g.ok) {
                Log("StageProbe: MEM scanpass t=%.3f took=%lums regions=%d reported=%ld",
                    t, (unsigned long)(GetTickCount() - scanBegin), g_regionCount, reported);
            }
            lastStat = GetTickCount();
        }
    }
    return 0;
}

// ---------------------------------------------------------------------------

static int EnvInt(const char* name, int fallback) {
    const char* v = getenv(name);
    if (!v || !*v) return fallback;
    return atoi(v);
}

void InstallStageProbeHook() {
    if (EnvInt("STAGE_PROBE", 0) == 0) return;

    g_t0 = GetTickCount();
    InitializeCriticalSection(&g_ioCs);

    bool wantIo = EnvInt("STAGE_PROBE_IO", 1) != 0;
    bool wantMem = EnvInt("STAGE_PROBE_MEM", 1) != 0;
    g_maxScanBytes = (SIZE_T)EnvInt("STAGE_PROBE_SCAN_MB", 16) * 1024 * 1024;
    g_maxRegionBytes = (SIZE_T)EnvInt("STAGE_PROBE_MAX_REGION_MB", 4) * 1024 * 1024;
    g_imageOnly = EnvInt("STAGE_PROBE_IMAGE_ONLY", 0);
    g_scanIntervalMs = (DWORD)EnvInt("STAGE_PROBE_INTERVAL_MS", 250);
    g_maxChanges = EnvInt("STAGE_PROBE_MAX_CHANGES", 12);
    g_maxValue = EnvInt("STAGE_PROBE_MAX_VALUE", 20);
    g_warmupSec = (double)EnvInt("STAGE_PROBE_WARMUP_SEC", 90);
    g_strict = EnvInt("STAGE_PROBE_STRICT", 1);
    g_counterMode = EnvInt("STAGE_PROBE_COUNTER", 0);
    g_counterMinRun = EnvInt("STAGE_PROBE_COUNTER_MIN_RUN", 8);
    g_counterMaxDelta = (LONGLONG)EnvInt("STAGE_PROBE_COUNTER_MAX_DELTA", 100000);

    if (wantIo) {
        bool a = HookIATEntry("KERNEL32.dll", "CreateFileA", (void*)MyCreateFileA, (void**)&g_origCreateFileA);
        bool w = HookIATEntry("KERNEL32.dll", "CreateFileW", (void*)MyCreateFileW, (void**)&g_origCreateFileW);
        bool rd = HookIATEntry("KERNEL32.dll", "ReadFile", (void*)MyReadFile, (void**)&g_origReadFile);
        bool sp = HookIATEntry("KERNEL32.dll", "SetFilePointer", (void*)MySetFilePointer, (void**)&g_origSetFilePointer);
        bool spx = HookIATEntry("KERNEL32.dll", "SetFilePointerEx", (void*)MySetFilePointerEx, (void**)&g_origSetFilePointerEx);
        bool ch = HookIATEntry("KERNEL32.dll", "CloseHandle", (void*)MyCloseHandle, (void**)&g_origCloseHandle);
        Log("StageProbe: IO hooks CreateFileA=%d CreateFileW=%d ReadFile=%d SetFilePointer=%d SetFilePointerEx=%d CloseHandle=%d",
            a, w, rd, sp, spx, ch);
        if (rd) CreateThread(NULL, 0, IoReportThread, NULL, 0, NULL);
    }
    if (wantMem) {
        CreateThread(NULL, 0, MemScanThread, NULL, 0, NULL);
    }
    Log("StageProbe: installed (io=%d mem=%d scanMB=%llu intervalMs=%lu maxChanges=%d maxValue=%d "
        "warmupSec=%.0f strict=%d)",
        (int)wantIo, (int)wantMem, (unsigned long long)(g_maxScanBytes / (1024 * 1024)),
        (unsigned long)g_scanIntervalMs, g_maxChanges, g_maxValue, g_warmupSec, g_strict);
}

} // namespace autoplay
