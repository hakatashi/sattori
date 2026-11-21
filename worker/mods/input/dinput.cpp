#include "input/dinput.h"
#include "core/log.h"
#include "core/pe_iat.h"
#include "core/vtable_hook.h"
#include "input/key_inject.h"

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
        // 複数デバイス(キーボード/マウス等)が同じ静的vtableを共有している(core/vtable_hook.h)。
        if (vtable::HookObject(*lplpDevice, 9, &MyGetDeviceState, &g_origGetDeviceState)) {
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
        // th20で、タイトルメニュー用とリプレイ再生開始後のゲームプレイ用で
        // DirectInput8Createが2回呼ばれることを確認した(touhou-recorder reports/44)。
        // 2回目のIDirectInput8インスタンスも同じ静的vtableを共有している(core/vtable_hook.h)。
        if (vtable::HookObject(*ppvOut, 3, &MyCreateDevice, &g_origCreateDevice)) {
            Log("DirectInput8Create: hooked CreateDevice (vtable[3])");
        } else {
            Log("DirectInput8Create: CreateDevice already hooked (shared vtable), skipping");
        }
    }
    return hr;
}

bool InstallDinputHook() {
    bool ok = iat::HookTyped(nullptr, "DINPUT8.dll", "DirectInput8Create", &MyDirectInput8Create,
                             &g_origDI8Create);
    Log("InstallDinputHook: IAT hook %s", ok ? "OK" : "FAILED (DirectInput8Create not found in IAT)");
    return ok;
}

void PressKey(BYTE dik, unsigned int holdFrames, unsigned int releaseFrames,
              unsigned int timeoutMs) {
    key_inject::Press(&g_hookCallCount, g_injectDik, dik, holdFrames, releaseFrames, timeoutMs);
}

static volatile BYTE g_injectVk[256] = {0};

typedef BOOL(WINAPI* GetKeyboardState_t)(PBYTE lpKeyState);
static GetKeyboardState_t g_origGetKeyboardState = nullptr;

static BOOL WINAPI MyGetKeyboardState(PBYTE lpKeyState) {
    BOOL ok = g_origGetKeyboardState(lpKeyState);
    InterlockedIncrement(&g_hookCallCount);
    if (ok && lpKeyState) {
        for (int i = 0; i < 256; i++) {
            if (g_injectVk[i]) lpKeyState[i] |= 0x80;
        }
    }
    return ok;
}

bool InstallKeyboardStateHook() {
    bool ok = iat::HookTyped(nullptr, "USER32.dll", "GetKeyboardState", &MyGetKeyboardState,
                             &g_origGetKeyboardState);
    Log("InstallKeyboardStateHook: IAT hook %s",
        ok ? "OK" : "FAILED (GetKeyboardState not found in IAT)");
    return ok;
}

void PressVKey(BYTE vk, unsigned int holdFrames, unsigned int releaseFrames,
               unsigned int timeoutMs) {
    key_inject::Press(&g_hookCallCount, g_injectVk, vk, holdFrames, releaseFrames, timeoutMs);
}

bool WaitForHookActive(unsigned int timeoutMs) {
    DWORD start = GetTickCount();
    while (GetTickCount() - start < timeoutMs) {
        if (g_hookCallCount > 0) {
            Log("WaitForHookActive: GetDeviceState hook active after %lu ms (count=%ld)",
                GetTickCount() - start, g_hookCallCount);
            return true;
        }
        Sleep(100);
    }
    Log("WaitForHookActive: TIMEOUT (count=%ld)", g_hookCallCount);
    return false;
}

} // namespace autoplay
