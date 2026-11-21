// IDXGISwapChain::Present のアダプタ(present/bus.h)。
//
// **#388(フレーム同期の移植)で初めて使う予定で、まだどのタイトルにも組み込んでいない
// (Makefile の CHECK_ONLY_SRCS。-Werror でコンパイルできることだけを CI で確かめている)。**
// touhou-recorder の mods/common/frame_sync_d3d11.cpp が独自に持っていた IAT・vtable の処理を
// ここへ寄せる受け皿で、組み込むときに実機で確かめること。
//
// フック連鎖(DXライブラリは D3D11 の関数を GetProcAddress で取得するので、IATではなく
// procaddr::Override から Wrap* を使う):
//   D3D11CreateDeviceAndSwapChain -> 返ったスワップチェーンの Present (vtable[8])
//   D3D11CreateDevice -> IDXGIDevice -> IDXGIAdapter -> IDXGIFactory
//     -> IDXGIFactory::CreateSwapChain (vtable[10]) / IDXGIFactory2::CreateSwapChainForHwnd (vtable[15])
//       -> 作られたスワップチェーンの Present (vtable[8])
// vtable の番号: IDXGISwapChain は IUnknown(3) + IDXGIObject(4) + GetDevice の次が Present。
// IDXGIFactory は IUnknown(3) + IDXGIObject(4) + EnumAdapters/MakeWindowAssociation/
// GetWindowAssociation の次が CreateSwapChain。IDXGIFactory2 の CreateSwapChainForHwnd は
// IDXGIFactory1(EnumAdapters1/IsCurrent)と IsWindowedStereoEnabled の次。

#include "present/bus.h"
#include "core/log.h"
#include "core/vtable_hook.h"

#include <d3d11.h>
#include <dxgi1_2.h>

namespace autoplay::present {

namespace {

typedef HRESULT(WINAPI* Present_t)(IDXGISwapChain*, UINT, UINT);
typedef HRESULT(WINAPI* CreateSwapChain_t)(IDXGIFactory*, IUnknown*, DXGI_SWAP_CHAIN_DESC*,
                                           IDXGISwapChain**);
typedef HRESULT(WINAPI* CreateSwapChainForHwnd_t)(IDXGIFactory2*, IUnknown*, HWND,
                                                  const DXGI_SWAP_CHAIN_DESC1*,
                                                  const DXGI_SWAP_CHAIN_FULLSCREEN_DESC*,
                                                  IDXGIOutput*, IDXGISwapChain1**);
typedef HRESULT(WINAPI* D3D11CreateDevice_t)(IDXGIAdapter*, D3D_DRIVER_TYPE, HMODULE, UINT,
                                             const D3D_FEATURE_LEVEL*, UINT, UINT, ID3D11Device**,
                                             D3D_FEATURE_LEVEL*, ID3D11DeviceContext**);
typedef HRESULT(WINAPI* D3D11CreateDeviceAndSwapChain_t)(
    IDXGIAdapter*, D3D_DRIVER_TYPE, HMODULE, UINT, const D3D_FEATURE_LEVEL*, UINT, UINT,
    const DXGI_SWAP_CHAIN_DESC*, IDXGISwapChain**, ID3D11Device**, D3D_FEATURE_LEVEL*,
    ID3D11DeviceContext**);

Present_t g_origPresent = nullptr;
CreateSwapChain_t g_origCreateSwapChain = nullptr;
CreateSwapChainForHwnd_t g_origCreateSwapChainForHwnd = nullptr;
D3D11CreateDevice_t g_origD3D11CreateDevice = nullptr;
D3D11CreateDeviceAndSwapChain_t g_origD3D11CreateDeviceAndSwapChain = nullptr;

HRESULT WINAPI MyPresent(IDXGISwapChain* sc, UINT syncInterval, UINT presentFlags) {
    const Frame frame{Api::kDxgi, sc, &syncInterval};
    unsigned flags = DispatchPre(frame);
    HRESULT hr = (flags & kSkip) ? S_OK : g_origPresent(sc, syncInterval, presentFlags);
    DispatchPost(frame, flags, hr);
    return hr;
}

HRESULT WINAPI MyCreateSwapChain(IDXGIFactory* factory, IUnknown* device, DXGI_SWAP_CHAIN_DESC* desc,
                                 IDXGISwapChain** out) {
    HRESULT hr = g_origCreateSwapChain(factory, device, desc, out);
    if (SUCCEEDED(hr) && out && *out) HookDxgiSwapChain(*out);
    return hr;
}

HRESULT WINAPI MyCreateSwapChainForHwnd(IDXGIFactory2* factory, IUnknown* device, HWND hwnd,
                                        const DXGI_SWAP_CHAIN_DESC1* desc,
                                        const DXGI_SWAP_CHAIN_FULLSCREEN_DESC* fsDesc,
                                        IDXGIOutput* output, IDXGISwapChain1** out) {
    HRESULT hr = g_origCreateSwapChainForHwnd(factory, device, hwnd, desc, fsDesc, output, out);
    if (SUCCEEDED(hr) && out && *out) HookDxgiSwapChain(*out);
    return hr;
}

// D3D11 デバイスから、それを作ったファクトリをたどってフックする。
void HookFactoryOfDevice(ID3D11Device* device) {
    if (!device) return;
    IDXGIDevice* dxgiDevice = nullptr;
    if (FAILED(device->QueryInterface(__uuidof(IDXGIDevice), (void**)&dxgiDevice)) || !dxgiDevice)
        return;
    IDXGIAdapter* adapter = nullptr;
    if (SUCCEEDED(dxgiDevice->GetAdapter(&adapter)) && adapter) {
        IDXGIFactory* factory = nullptr;
        if (SUCCEEDED(adapter->GetParent(__uuidof(IDXGIFactory), (void**)&factory)) && factory) {
            HookDxgiFactory(factory);
            factory->Release();
        }
        adapter->Release();
    }
    dxgiDevice->Release();
}

HRESULT WINAPI MyD3D11CreateDevice(IDXGIAdapter* a, D3D_DRIVER_TYPE t, HMODULE m, UINT f,
                                   const D3D_FEATURE_LEVEL* l, UINT n, UINT v, ID3D11Device** d,
                                   D3D_FEATURE_LEVEL* fl, ID3D11DeviceContext** c) {
    HRESULT hr = g_origD3D11CreateDevice(a, t, m, f, l, n, v, d, fl, c);
    if (SUCCEEDED(hr) && d && *d) HookFactoryOfDevice(*d);
    return hr;
}

HRESULT WINAPI MyD3D11CreateDeviceAndSwapChain(IDXGIAdapter* a, D3D_DRIVER_TYPE t, HMODULE m,
                                               UINT f, const D3D_FEATURE_LEVEL* l, UINT n, UINT v,
                                               const DXGI_SWAP_CHAIN_DESC* sd, IDXGISwapChain** sc,
                                               ID3D11Device** d, D3D_FEATURE_LEVEL* fl,
                                               ID3D11DeviceContext** c) {
    HRESULT hr = g_origD3D11CreateDeviceAndSwapChain(a, t, m, f, l, n, v, sd, sc, d, fl, c);
    if (SUCCEEDED(hr) && sc && *sc) HookDxgiSwapChain(*sc);
    return hr;
}

}  // namespace

void HookDxgiSwapChain(void* swapChain) {
    if (!swapChain) return;
    if (vtable::HookObject(swapChain, 8, &MyPresent, &g_origPresent))
        Log("DXGI: hooked IDXGISwapChain::Present (vtable[8])");
    DispatchDevice(Api::kDxgi, swapChain);
}

void HookDxgiFactory(void* factory) {
    if (!factory) return;
    auto* f = (IDXGIFactory*)factory;
    if (vtable::HookObject(f, 10, &MyCreateSwapChain, &g_origCreateSwapChain))
        Log("DXGI: hooked IDXGIFactory::CreateSwapChain (vtable[10])");
    IDXGIFactory2* f2 = nullptr;
    if (SUCCEEDED(f->QueryInterface(__uuidof(IDXGIFactory2), (void**)&f2)) && f2) {
        if (vtable::HookObject(f2, 15, &MyCreateSwapChainForHwnd, &g_origCreateSwapChainForHwnd))
            Log("DXGI: hooked IDXGIFactory2::CreateSwapChainForHwnd (vtable[15])");
        f2->Release();
    }
}

void* WrapD3D11CreateDevice(void* real) {
    if (!real || real == (void*)MyD3D11CreateDevice) return real;
    if (!g_origD3D11CreateDevice) g_origD3D11CreateDevice = (D3D11CreateDevice_t)real;
    return (void*)MyD3D11CreateDevice;
}

void* WrapD3D11CreateDeviceAndSwapChain(void* real) {
    if (!real || real == (void*)MyD3D11CreateDeviceAndSwapChain) return real;
    if (!g_origD3D11CreateDeviceAndSwapChain)
        g_origD3D11CreateDeviceAndSwapChain = (D3D11CreateDeviceAndSwapChain_t)real;
    return (void*)MyD3D11CreateDeviceAndSwapChain;
}

}  // namespace autoplay::present
