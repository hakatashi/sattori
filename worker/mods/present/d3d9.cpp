// IDirect3DDevice9::Present のアダプタ(present/bus.h)。
//
// フック連鎖:
//   IAT フック: d3d9.dll!Direct3DCreate9
//     -> vtable フック: IDirect3D9::CreateDevice (vtable[16])
//       -> vtable フック: IDirect3DDevice9::Present (vtable[17])
//
// COM interfaceは、DirectX SDKヘッダを使わずABI互換な素の型のみで宣言する
// (input/dinput.cppと同じ方針)。

#include "present/bus.h"
#include "core/log.h"
#include "core/pe_iat.h"
#include "core/vtable_hook.h"

namespace autoplay::present {

namespace {

typedef void*(WINAPI* Direct3DCreate9_t)(UINT SDKVersion);
typedef HRESULT(WINAPI* CreateDevice_t)(void* pThis, UINT Adapter, DWORD DeviceType,
                                        HWND hFocusWindow, DWORD BehaviorFlags,
                                        void* pPresentationParameters,
                                        void** ppReturnedDeviceInterface);
typedef HRESULT(WINAPI* Present_t)(void* pThis, const void* pSourceRect, const void* pDestRect,
                                   HWND hDestWindowOverride, const void* pDirtyRegion);

Direct3DCreate9_t g_origDirect3DCreate9 = nullptr;
CreateDevice_t g_origCreateDevice = nullptr;
Present_t g_origPresent = nullptr;

HRESULT WINAPI MyPresent(void* pThis, const void* pSourceRect, const void* pDestRect,
                         HWND hDestWindowOverride, const void* pDirtyRegion) {
    const Frame frame{Api::kD3D9, pThis, nullptr};
    unsigned flags = DispatchPre(frame);
    HRESULT hr = (flags & kSkip) ? S_OK
                                 : g_origPresent(pThis, pSourceRect, pDestRect,
                                                 hDestWindowOverride, pDirtyRegion);
    DispatchPost(frame, flags, hr);
    return hr;
}

HRESULT WINAPI MyCreateDevice(void* pThis, UINT Adapter, DWORD DeviceType, HWND hFocusWindow,
                              DWORD BehaviorFlags, void* pPresentationParameters,
                              void** ppReturnedDeviceInterface) {
    HRESULT hr = g_origCreateDevice(pThis, Adapter, DeviceType, hFocusWindow, BehaviorFlags,
                                    pPresentationParameters, ppReturnedDeviceInterface);
    if (SUCCEEDED(hr) && ppReturnedDeviceInterface && *ppReturnedDeviceInterface) {
        if (vtable::HookObject(*ppReturnedDeviceInterface, 17, &MyPresent, &g_origPresent)) {
            Log("CreateDevice: hooked Present (vtable[17])");
        } else {
            Log("CreateDevice: Present already hooked (shared vtable), skipping");
        }
        DispatchDevice(Api::kD3D9, *ppReturnedDeviceInterface);
    }
    return hr;
}

void* WINAPI MyDirect3DCreate9(UINT SDKVersion) {
    void* pD3D9 = g_origDirect3DCreate9(SDKVersion);
    if (pD3D9) {
        if (vtable::HookObject(pD3D9, 16, &MyCreateDevice, &g_origCreateDevice)) {
            Log("Direct3DCreate9: hooked CreateDevice (vtable[16])");
        } else {
            Log("Direct3DCreate9: CreateDevice already hooked (shared vtable), skipping");
        }
    }
    return pD3D9;
}

}  // namespace

bool InstallD3D9() {
    if (g_origDirect3DCreate9) return true;
    return iat::HookTyped(nullptr, "d3d9.dll", "Direct3DCreate9", &MyDirect3DCreate9,
                          &g_origDirect3DCreate9);
}

}  // namespace autoplay::present
