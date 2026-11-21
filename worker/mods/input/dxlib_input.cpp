#include "input/dxlib_input.h"
#include "core/log.h"
#include "core/pe_iat.h"
#include "input/key_inject.h"

namespace autoplay::dxlib {

volatile LONG g_pollCount = 0;

namespace {

volatile BYTE g_injectVk[256] = {0};

typedef BOOL(WINAPI* GetKeyboardState_t)(PBYTE);
typedef SHORT(WINAPI* GetAsyncKeyState_t)(int);
GetKeyboardState_t g_origGetKeyboardState = nullptr;
GetAsyncKeyState_t g_origGetAsyncKeyState = nullptr;

BOOL WINAPI MyGetKeyboardState(PBYTE lpKeyState) {
    BOOL ok = g_origGetKeyboardState ? g_origGetKeyboardState(lpKeyState) : FALSE;
    InterlockedIncrement(&g_pollCount);
    if (ok && lpKeyState) {
        for (int i = 0; i < 256; i++) {
            if (g_injectVk[i]) lpKeyState[i] |= 0x80;
        }
    }
    return ok;
}

SHORT WINAPI MyGetAsyncKeyState(int vKey) {
    SHORT result = g_origGetAsyncKeyState ? g_origGetAsyncKeyState(vKey) : 0;
    InterlockedIncrement(&g_pollCount);
    if (vKey >= 0 && vKey < 256 && g_injectVk[vKey]) {
        result |= (SHORT)0x8001;
    }
    return result;
}

// 本物の取得に失敗していても(null)自前の関数を返す(呼ばれたら本物が無い前提で動く)。
void* WrapGetKeyboardState(void* real) {
    if (!g_origGetKeyboardState) {
        g_origGetKeyboardState = (GetKeyboardState_t)real;
        Log("GetProcAddress hook: GetKeyboardState を自前実装に差し替えました");
    }
    return (void*)MyGetKeyboardState;
}

void* WrapGetAsyncKeyState(void* real) {
    if (!g_origGetAsyncKeyState) g_origGetAsyncKeyState = (GetAsyncKeyState_t)real;
    return (void*)MyGetAsyncKeyState;
}

}  // namespace

void RegisterInputOverrides(bool hookAsyncKeyState) {
    procaddr::Override("GetKeyboardState", WrapGetKeyboardState, /*evenIfNull=*/true);
    if (hookAsyncKeyState) procaddr::Override("GetAsyncKeyState", WrapGetAsyncKeyState, /*evenIfNull=*/true);
}

void PressVKey(BYTE vk, unsigned int holdFrames, unsigned int releaseFrames, unsigned int timeoutMs) {
    key_inject::Press(&g_pollCount, g_injectVk, vk, holdFrames, releaseFrames, timeoutMs);
}

}  // namespace autoplay::dxlib
