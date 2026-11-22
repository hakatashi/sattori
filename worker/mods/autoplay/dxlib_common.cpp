#include "autoplay/dxlib_common.h"
#include "audio/dsound.h"
#include "audio/virtual/wasapi_mixer.h"
#include "audio/wasapi.h"
#include "clock/speed_hack.h"
#include "clock/virtual_clock.h"
#include "core/log.h"
#include "core/pe_iat.h"
#include "core/runtime_config.h"
#include "input/dxlib_input.h"
#include "present/bus.h"
#include <wchar.h>

namespace autoplay::dxlib {

namespace {

// 倍速録画(Issue #288、touhou-recorder reports/89・90)。DXライブラリは音声APIを
// CoCreateInstanceで作るため、生成されたオブジェクトをフックして倍速時の再生レート
// スケールと同期マーカー(reports/88)を効かせる。音声は実際にはWASAPIで出ている
// (CLSID_MMDeviceEnumeratorの生成とmmdevapi.dllのロードを確認、dsound.dll/XAudio2は
// ロードされない)が、DirectSound版のエンジンにも備えてDirectSoundもフックしておく。
typedef HRESULT(WINAPI* CoCreateInstance_t)(REFCLSID, LPUNKNOWN, DWORD, REFIID, LPVOID*);
CoCreateInstance_t g_origCoCreateInstance = nullptr;
const GUID kCLSID_DirectSound8 = {0x3901cc3f, 0x84b5, 0x4fa4, {0xba, 0x35, 0xaa, 0x81, 0x72, 0xb8, 0xa0, 0x9b}};
const GUID kCLSID_DirectSound = {0x47d4d946, 0x62e8, 0x11cf, {0x93, 0xbc, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00}};
const GUID kCLSID_MMDeviceEnumerator = {0xbcde0395, 0xe52f, 0x467c, {0x8e, 0x3d, 0xc4, 0x57, 0x92, 0x91, 0x69, 0x2e}};

HRESULT WINAPI MyCoCreateInstance(REFCLSID rclsid, LPUNKNOWN outer, DWORD ctx, REFIID riid, LPVOID* ppv) {
    HRESULT hr = g_origCoCreateInstance(rclsid, outer, ctx, riid, ppv);
    const bool fs = Config().FrameSyncEnabled();
    if (!fs) {
        Log("CoCreateInstance: clsid={%08lX-%04X-%04X-...} hr=0x%08lX",
            (unsigned long)rclsid.Data1, rclsid.Data2, rclsid.Data3, (unsigned long)hr);
    }
    if (SUCCEEDED(hr) && ppv && *ppv && !fs &&
        (IsEqualGUID(rclsid, kCLSID_DirectSound8) || IsEqualGUID(rclsid, kCLSID_DirectSound))) {
        HookDirectSoundObject(*ppv);
    }
    if (SUCCEEDED(hr) && ppv && *ppv && IsEqualGUID(rclsid, kCLSID_MMDeviceEnumerator)) {
        if (audio::wasapi_mixer::Active()) {
            audio::wasapi_mixer::HookMMDeviceEnumerator(*ppv);
        } else {
            HookMMDeviceEnumerator(*ppv);
        }
    }
    return hr;
}

void* WrapCoCreateInstance(void* real) {
    if (!g_origCoCreateInstance) g_origCoCreateInstance = (CoCreateInstance_t)real;
    return (void*)MyCoCreateInstance;
}

void* WrapDirectSoundCreate8Logged(void* real) {
    Log("GetProcAddress hook: DirectSoundCreate8 をフック版に差し替えました");
    return WrapDirectSoundCreate8(real);
}

void* WrapQpcLogged(void* real) {
    Log("GetProcAddress hook: QueryPerformanceCounter を倍速用に差し替えました");
    return WrapQueryPerformanceCounterForSpeedHack(real);
}

struct DialogSearch {
    DWORD pid;
    HWND found;
};

BOOL CALLBACK FindDialogProc(HWND hwnd, LPARAM lparam) {
    auto* search = (DialogSearch*)lparam;
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid != search->pid) return TRUE;
    if (!IsWindowVisible(hwnd)) return TRUE;

    wchar_t cls[64] = {0};
    GetClassNameW(hwnd, cls, 64);
    if (wcscmp(cls, L"#32770") != 0) return TRUE;  // ダイアログの標準クラス

    search->found = hwnd;
    return FALSE;
}

}  // namespace

void InstallHooks(const Options& options) {
    // 入力(本物の取得に失敗していても差し替える)。
    RegisterInputOverrides(options.hookAsyncKeyState);

    if (Config().FrameSyncEnabled()) {
        procaddr::Override("QueryPerformanceCounter", virtual_clock::WrapQueryPerformanceCounter);
        procaddr::Override("timeGetTime", virtual_clock::WrapTimeGetTime);
        procaddr::Override("GetTickCount", virtual_clock::WrapGetTickCount);
        procaddr::Override("GetTickCount64", virtual_clock::WrapGetTickCount64);
        procaddr::Override("Sleep", virtual_clock::WrapSleep);
        procaddr::Override("WaitForSingleObject", virtual_clock::WrapWaitForSingleObject);
        procaddr::Override("D3D11CreateDevice", present::WrapD3D11CreateDevice);
        procaddr::Override("D3D11CreateDeviceAndSwapChain",
                           present::WrapD3D11CreateDeviceAndSwapChain);
        procaddr::Override("CreateDXGIFactory", present::WrapCreateDXGIFactory);
        procaddr::Override("CreateDXGIFactory1", present::WrapCreateDXGIFactory1);
        procaddr::Override("CreateDXGIFactory2", present::WrapCreateDXGIFactory2);
        procaddr::Override("CoCreateInstance", WrapCoCreateInstance);
        procaddr::Install();
        iat::HookTyped(nullptr, "ole32.dll", "CoCreateInstance", &MyCoCreateInstance,
                       &g_origCoCreateInstance);
        return;
    }

    // 倍速録画(Issue #288)。DXライブラリはQPC・timeGetTime・音声APIをGetProcAddressで
    // 動的に取得するため、IATではなくここで差し替える。取得に失敗した(NULL)関数は
    // フック版に差し替えない(procaddr::Override の既定)。
    procaddr::Override("DirectSoundCreate8", WrapDirectSoundCreate8Logged);
    procaddr::Override("timeGetTime", WrapTimeGetTimeForSpeedHack);
    procaddr::Override("CoCreateInstance", WrapCoCreateInstance);
    procaddr::Override("QueryPerformanceCounter", WrapQpcLogged);

    bool ok = procaddr::Install();
    Log("GetProcAddress IAT hook: %s", ok ? "OK" : "FAILED");

    // exeのIATにCoCreateInstanceは無くFAILEDになるが(GetProcAddress経由で捕捉する)、
    // 念のため試みる。
    bool okCo = iat::HookTyped(nullptr, "ole32.dll", "CoCreateInstance", &MyCoCreateInstance,
                               &g_origCoCreateInstance);
    Log("CoCreateInstance IAT hook: %s", okCo ? "OK" : "FAILED");
}

HWND FindStartupDialog(DWORD pid) {
    DialogSearch search{pid, nullptr};
    EnumWindows(FindDialogProc, (LPARAM)&search);
    return search.found;
}

}  // namespace autoplay::dxlib
