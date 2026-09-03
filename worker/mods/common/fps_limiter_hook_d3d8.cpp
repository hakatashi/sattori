#include "fps_limiter_hook_d3d8.h"
#include "logging.h"
#include <stdlib.h>

namespace autoplay {

// COM interface信頼のため、DirectX SDKヘッダを使わずABI互換な素の型のみで宣言する
// (fps_limiter_hook.cppと同じ方針)。D3D8とD3D9でCreateDevice/Presentの
// パラメータの並び自体は同じ形なので、関数ポインタ型はfps_limiter_hook.cppの
// ものと同一定義で流用できる。

typedef void* (WINAPI* Direct3DCreate8_t)(UINT SDKVersion);
typedef HRESULT(WINAPI* CreateDevice8_t)(void* pThis, UINT Adapter, DWORD DeviceType,
                                          HWND hFocusWindow, DWORD BehaviorFlags,
                                          void* pPresentationParameters,
                                          void** ppReturnedDeviceInterface);
typedef HRESULT(WINAPI* Present8_t)(void* pThis, const void* pSourceRect,
                                     const void* pDestRect, HWND hDestWindowOverride,
                                     const void* pDirtyRegion);

static Direct3DCreate8_t g_origDirect3DCreate8 = nullptr;
static CreateDevice8_t g_origCreateDevice8 = nullptr;
static Present8_t g_origPresent8 = nullptr;

static double g_targetIntervalSec = 1.0 / 60.0;
static LARGE_INTEGER g_qpcFreq = {0};
static LARGE_INTEGER g_lastPresentQpc = {0};
static bool g_haveLastPresent = false;

static void PatchVTable(void** vtable, int index, void* newFunc, void** outOld) {
    DWORD oldProt;
    VirtualProtect(&vtable[index], sizeof(void*), PAGE_EXECUTE_READWRITE, &oldProt);
    if (outOld) *outOld = vtable[index];
    vtable[index] = newFunc;
    VirtualProtect(&vtable[index], sizeof(void*), oldProt, &oldProt);
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
            VirtualProtect(&thunk->u1.Function, sizeof(void*), PAGE_EXECUTE_READWRITE,
                            &oldProt);
            if (outOld) *outOld = (void*)thunk->u1.Function;
            thunk->u1.Function = (ULONG_PTR)newFunc;
            VirtualProtect(&thunk->u1.Function, sizeof(void*), oldProt, &oldProt);
            return true;
        }
    }
    return false;
}

static HRESULT WINAPI MyPresent8(void* pThis, const void* pSourceRect,
                                  const void* pDestRect, HWND hDestWindowOverride,
                                  const void* pDirtyRegion) {
    LARGE_INTEGER now;
    QueryPerformanceCounter(&now);
    if (g_haveLastPresent) {
        double elapsed = (double)(now.QuadPart - g_lastPresentQpc.QuadPart) /
                          (double)g_qpcFreq.QuadPart;
        double remaining = g_targetIntervalSec - elapsed;
        if (remaining > 0.0) {
            DWORD ms = (DWORD)(remaining * 1000.0);
            if (ms > 0) Sleep(ms);
            LARGE_INTEGER spin;
            do {
                QueryPerformanceCounter(&spin);
            } while ((double)(spin.QuadPart - now.QuadPart) / (double)g_qpcFreq.QuadPart <
                     remaining);
        }
    }

    HRESULT hr = g_origPresent8(pThis, pSourceRect, pDestRect, hDestWindowOverride,
                                 pDirtyRegion);

    QueryPerformanceCounter(&g_lastPresentQpc);
    g_haveLastPresent = true;
    return hr;
}

static HRESULT WINAPI MyCreateDevice8(void* pThis, UINT Adapter, DWORD DeviceType,
                                       HWND hFocusWindow, DWORD BehaviorFlags,
                                       void* pPresentationParameters,
                                       void** ppReturnedDeviceInterface) {
    HRESULT hr = g_origCreateDevice8(pThis, Adapter, DeviceType, hFocusWindow,
                                      BehaviorFlags, pPresentationParameters,
                                      ppReturnedDeviceInterface);
    if (SUCCEEDED(hr) && ppReturnedDeviceInterface && *ppReturnedDeviceInterface) {
        void** vtable = *(void***)(*ppReturnedDeviceInterface);
        if (vtable[15] != (void*)MyPresent8) {
            PatchVTable(vtable, 15, (void*)MyPresent8, (void**)&g_origPresent8);
            Log("CreateDevice8: hooked Present (vtable[15]) for fps limiting");
        } else {
            Log("CreateDevice8: Present already hooked (shared vtable), skipping");
        }
    }
    return hr;
}

static void* WINAPI MyDirect3DCreate8(UINT SDKVersion) {
    void* pD3D8 = g_origDirect3DCreate8(SDKVersion);
    if (pD3D8) {
        void** vtable = *(void***)pD3D8;
        if (vtable[15] != (void*)MyCreateDevice8) {
            PatchVTable(vtable, 15, (void*)MyCreateDevice8, (void**)&g_origCreateDevice8);
            Log("Direct3DCreate8: hooked CreateDevice (vtable[15])");
        } else {
            Log("Direct3DCreate8: CreateDevice already hooked (shared vtable), skipping");
        }
    }
    return pD3D8;
}

bool InstallFpsLimiterHookD3D8(double targetHz) {
    QueryPerformanceFrequency(&g_qpcFreq);

    const char* env = getenv("FPS_LIMIT_TARGET_HZ");
    if (env) {
        double hz = atof(env);
        if (hz > 0.0) targetHz = hz;
    }
    g_targetIntervalSec = 1.0 / targetHz;

    bool ok = HookIATEntry("d3d8.dll", "Direct3DCreate8", (void*)MyDirect3DCreate8,
                            (void**)&g_origDirect3DCreate8);
    Log("InstallFpsLimiterHookD3D8: IAT hook %s (target=%.2f fps)",
        ok ? "OK" : "FAILED (Direct3DCreate8 not found in IAT)", targetHz);
    return ok;
}

} // namespace autoplay
