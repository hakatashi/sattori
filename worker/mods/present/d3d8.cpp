// IDirect3DDevice8::Present のアダプタ(present/bus.h)。th09(Direct3D8エンジン。
// thprac_th09.cppのGameGuiInitがIMPL_WIN32_DX8を指定)で使う。
//
// フック連鎖:
//   IAT フック: d3d8.dll!Direct3DCreate8
//     -> vtable フック: IDirect3D8::CreateDevice (vtable[15])
//       -> vtable フック: IDirect3DDevice8::Present (vtable[15])
//
// vtable番号の根拠(d3d8.h、DirectX8 SDK):
//   IDirect3D8は IUnknown(3) + RegisterSoftwareDevice/GetAdapterCount/
//   GetAdapterIdentifier/GetAdapterModeCount/EnumAdapterModes/
//   GetAdapterDisplayMode/CheckDeviceType/CheckDeviceFormat/
//   CheckDeviceMultiSampleType/CheckDepthStencilMatch/GetDeviceCaps/
//   GetAdapterMonitor(12個)の後にCreateDevice、よって0-indexedで15。
//   D3D9のIDirect3D9はこれに加えてCheckDeviceFormatConversionが1つ多いため
//   CreateDeviceは16。
//   IDirect3DDevice8は IUnknown(3) + TestCooperativeLevel/
//   GetAvailableTextureMem/ResourceManagerDiscardBytes/GetDirect3D/
//   GetDeviceCaps/GetDisplayMode/GetCreationParameters/SetCursorProperties/
//   SetCursorPosition/ShowCursor/CreateAdditionalSwapChain/Reset(12個)の後に
//   Presentのため0-indexedで15。D3D9のIDirect3DDevice9はこれに加えて
//   GetSwapChain/GetNumberOfSwapChainsが2つ多いためPresentは17。
// CreateDevice/Presentのパラメータの並び自体はD3D9と同じ形。

#include "present/bus.h"
#include "core/log.h"
#include "core/pe_iat.h"
#include "core/vtable_hook.h"

namespace autoplay::present {

namespace {

typedef void*(WINAPI* Direct3DCreate8_t)(UINT SDKVersion);
typedef HRESULT(WINAPI* CreateDevice8_t)(void* pThis, UINT Adapter, DWORD DeviceType,
                                         HWND hFocusWindow, DWORD BehaviorFlags,
                                         void* pPresentationParameters,
                                         void** ppReturnedDeviceInterface);
typedef HRESULT(WINAPI* Present8_t)(void* pThis, const void* pSourceRect, const void* pDestRect,
                                    HWND hDestWindowOverride, const void* pDirtyRegion);

Direct3DCreate8_t g_origDirect3DCreate8 = nullptr;
CreateDevice8_t g_origCreateDevice8 = nullptr;
Present8_t g_origPresent8 = nullptr;

HRESULT WINAPI MyPresent8(void* pThis, const void* pSourceRect, const void* pDestRect,
                          HWND hDestWindowOverride, const void* pDirtyRegion) {
    const Frame frame{Api::kD3D8, pThis, nullptr};
    unsigned flags = DispatchPre(frame);
    HRESULT hr = (flags & kSkip) ? S_OK
                                 : g_origPresent8(pThis, pSourceRect, pDestRect,
                                                  hDestWindowOverride, pDirtyRegion);
    DispatchPost(frame, flags, hr);
    return hr;
}

HRESULT WINAPI MyCreateDevice8(void* pThis, UINT Adapter, DWORD DeviceType, HWND hFocusWindow,
                               DWORD BehaviorFlags, void* pPresentationParameters,
                               void** ppReturnedDeviceInterface) {
    HRESULT hr = g_origCreateDevice8(pThis, Adapter, DeviceType, hFocusWindow, BehaviorFlags,
                                     pPresentationParameters, ppReturnedDeviceInterface);
    if (SUCCEEDED(hr) && ppReturnedDeviceInterface && *ppReturnedDeviceInterface) {
        if (vtable::HookObject(*ppReturnedDeviceInterface, 15, &MyPresent8, &g_origPresent8)) {
            Log("CreateDevice8: hooked Present (vtable[15])");
        } else {
            Log("CreateDevice8: Present already hooked (shared vtable), skipping");
        }
        DispatchDevice(Api::kD3D8, *ppReturnedDeviceInterface);
    }
    return hr;
}

void* WINAPI MyDirect3DCreate8(UINT SDKVersion) {
    void* pD3D8 = g_origDirect3DCreate8(SDKVersion);
    if (pD3D8) {
        if (vtable::HookObject(pD3D8, 15, &MyCreateDevice8, &g_origCreateDevice8)) {
            Log("Direct3DCreate8: hooked CreateDevice (vtable[15])");
        } else {
            Log("Direct3DCreate8: CreateDevice already hooked (shared vtable), skipping");
        }
    }
    return pD3D8;
}

}  // namespace

bool InstallD3D8() {
    if (g_origDirect3DCreate8) return true;
    return iat::HookTyped(nullptr, "d3d8.dll", "Direct3DCreate8", &MyDirect3DCreate8,
                          &g_origDirect3DCreate8);
}

}  // namespace autoplay::present
