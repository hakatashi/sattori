#include "dinput_hook.h"
#include "logging.h"

namespace autoplay {

volatile LONG g_hookCallCount = 0;
static volatile BYTE g_injectDik[256] = {0};

// COM の REFIID/LPUNKNOWN 等を使わず、ABI 互換な素の型 (HRESULT __stdcall,
// ポインタ渡し) だけで宣言する。フォワードするだけで中身を解釈しないため、
// DirectX SDK のヘッダは不要。
typedef HRESULT(WINAPI* DirectInput8Create_t)(HINSTANCE hinst, DWORD dwVersion,
                                               const void* riidltf, void** ppvOut,
                                               void* punkOuter);
typedef HRESULT(WINAPI* CreateDevice_t)(void* pThis, const void* rguid,
                                         void** lplpDevice, void* pUnkOuter);
typedef HRESULT(WINAPI* GetDeviceState_t)(void* pThis, DWORD cbData, void* lpvData);

static DirectInput8Create_t g_origDI8Create = nullptr;
static CreateDevice_t g_origCreateDevice = nullptr;
static GetDeviceState_t g_origGetDeviceState = nullptr;

static HRESULT WINAPI MyGetDeviceState(void* pThis, DWORD cbData, void* lpvData);
static HRESULT WINAPI MyCreateDevice(void* pThis, const void* rguid, void** lplpDevice,
                                      void* pUnkOuter);
static HRESULT WINAPI MyDirectInput8Create(HINSTANCE hinst, DWORD dwVersion,
                                            const void* riidltf, void** ppvOut,
                                            void* punkOuter);

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

static HRESULT WINAPI MyGetDeviceState(void* pThis, DWORD cbData, void* lpvData) {
    HRESULT hr = g_origGetDeviceState(pThis, cbData, lpvData);
    InterlockedIncrement(&g_hookCallCount);
    if (SUCCEEDED(hr) && lpvData && cbData >= 256) {
        BYTE* buf = (BYTE*)lpvData;
        for (int i = 0; i < 256; i++) {
            if (g_injectDik[i]) buf[i] = 0x80;
        }
    }
    return hr;
}

static HRESULT WINAPI MyCreateDevice(void* pThis, const void* rguid, void** lplpDevice,
                                      void* pUnkOuter) {
    HRESULT hr = g_origCreateDevice(pThis, rguid, lplpDevice, pUnkOuter);
    if (SUCCEEDED(hr) && lplpDevice && *lplpDevice) {
        void** vtable = *(void***)(*lplpDevice);
        // 複数デバイス(キーボード/マウス等)がこの実装では同じ静的vtableを
        // 共有している。既にフック済み(vtable[9]==MyGetDeviceState)の状態で
        // 再度パッチすると、PatchVTableのoutOldが「本物のオリジナル」ではなく
        // MyGetDeviceState自身を保存してしまい、次回呼び出し時に無限再帰
        // (スタックオーバーフロー)でクラッシュする。そのため既にフック済みか
        // どうかを確認してから初回のみパッチする。
        if (vtable[9] != (void*)MyGetDeviceState) {
            PatchVTable(vtable, 9, (void*)MyGetDeviceState, (void**)&g_origGetDeviceState);
            Log("CreateDevice: hooked GetDeviceState (vtable[9])");
        } else {
            Log("CreateDevice: GetDeviceState already hooked (shared vtable), skipping");
        }
    }
    return hr;
}

static HRESULT WINAPI MyDirectInput8Create(HINSTANCE hinst, DWORD dwVersion,
                                            const void* riidltf, void** ppvOut,
                                            void* punkOuter) {
    HRESULT hr = g_origDI8Create(hinst, dwVersion, riidltf, ppvOut, punkOuter);
    if (SUCCEEDED(hr) && ppvOut && *ppvOut) {
        void** vtable = *(void***)(*ppvOut);
        PatchVTable(vtable, 3, (void*)MyCreateDevice, (void**)&g_origCreateDevice);
        Log("DirectInput8Create: hooked CreateDevice (vtable[3])");
    }
    return hr;
}

bool InstallDinputHook() {
    bool ok = HookIATEntry("DINPUT8.dll", "DirectInput8Create",
                            (void*)MyDirectInput8Create, (void**)&g_origDI8Create);
    Log("InstallDinputHook: IAT hook %s", ok ? "OK" : "FAILED (DirectInput8Create not found in IAT)");
    return ok;
}

// g_hookCallCount が startCount から frames 回分進むか、timeoutMs 経過する
// まで待つ(異常時のフォールバックとして)。
static void WaitFrames(LONG startCount, unsigned int frames, unsigned int timeoutMs) {
    DWORD start = GetTickCount();
    while ((g_hookCallCount - startCount) < (LONG)frames) {
        if (GetTickCount() - start >= timeoutMs) return;
        Sleep(1);
    }
}

void PressKey(BYTE dik, unsigned int holdFrames, unsigned int releaseFrames,
              unsigned int timeoutMs) {
    LONG holdStart = g_hookCallCount;
    g_injectDik[dik] = 1;
    WaitFrames(holdStart, holdFrames, timeoutMs);

    LONG releaseStart = g_hookCallCount;
    g_injectDik[dik] = 0;
    WaitFrames(releaseStart, releaseFrames, timeoutMs);
}

} // namespace autoplay
