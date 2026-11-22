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
#include "core/runtime_config.h"
#include "core/vtable_hook.h"

#include <d3d11.h>
#include <dxgi1_2.h>

namespace autoplay::present {

namespace {

// -ldxguid に頼らず th06c でもリンクできるよう IID はここで定義する。
const GUID kIID_IDXGIFactory = {
    0x7b7166ec, 0x21c7, 0x44ae, {0xb2, 0x1a, 0xc9, 0xae, 0x32, 0x1a, 0xe3, 0x69}};
const GUID kIID_IDXGIDevice = {
    0x54ec77fa, 0x1377, 0x44e6, {0x8c, 0x32, 0x88, 0xfd, 0x5f, 0x44, 0xc8, 0x4c}};
const GUID kIID_IDXGIFactory2 = {
    0x50c83a1c, 0xe072, 0x4c48, {0x87, 0xb0, 0x36, 0x30, 0xfa, 0x36, 0xa6, 0xd0}};

typedef HRESULT(WINAPI* Present_t)(IDXGISwapChain*, UINT, UINT);
typedef HRESULT(WINAPI* ResizeBuffers_t)(IDXGISwapChain*, UINT, UINT, UINT, DXGI_FORMAT, UINT);
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
typedef HRESULT(WINAPI* CreateDXGIFactory_t)(REFIID, void**);
typedef HRESULT(WINAPI* CreateDXGIFactory2_t)(UINT, REFIID, void**);

Present_t g_origPresent = nullptr;
ResizeBuffers_t g_origResizeBuffers = nullptr;
CreateSwapChain_t g_origCreateSwapChain = nullptr;
CreateSwapChainForHwnd_t g_origCreateSwapChainForHwnd = nullptr;
D3D11CreateDevice_t g_origD3D11CreateDevice = nullptr;
D3D11CreateDeviceAndSwapChain_t g_origD3D11CreateDeviceAndSwapChain = nullptr;
CreateDXGIFactory_t g_origCreateDXGIFactory = nullptr;
CreateDXGIFactory_t g_origCreateDXGIFactory1 = nullptr;
CreateDXGIFactory2_t g_origCreateDXGIFactory2 = nullptr;

HRESULT WINAPI MyPresent(IDXGISwapChain* sc, UINT syncInterval, UINT presentFlags) {
    const Frame frame{Api::kDxgi, sc, &syncInterval};
    unsigned flags = DispatchPre(frame);
    HRESULT hr = (flags & kSkip) ? S_OK : g_origPresent(sc, syncInterval, presentFlags);
    DispatchPost(frame, flags, hr);
    return hr;
}

HRESULT WINAPI MyResizeBuffers(IDXGISwapChain* sc, UINT cnt, UINT w, UINT h, DXGI_FORMAT fmt,
                                 UINT presentFlags) {
    DispatchResize(Api::kDxgi, sc, w, h, (DWORD)fmt);
    return g_origResizeBuffers(sc, cnt, w, h, fmt, presentFlags);
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
    if (FAILED(device->QueryInterface(kIID_IDXGIDevice, (void**)&dxgiDevice)) || !dxgiDevice)
        return;
    IDXGIAdapter* adapter = nullptr;
    if (SUCCEEDED(dxgiDevice->GetAdapter(&adapter)) && adapter) {
        IDXGIFactory* factory = nullptr;
        if (SUCCEEDED(adapter->GetParent(kIID_IDXGIFactory, (void**)&factory)) && factory) {
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

HRESULT WINAPI MyCreateDXGIFactory(REFIID riid, void** ppv) {
    HRESULT hr = g_origCreateDXGIFactory(riid, ppv);
    if (SUCCEEDED(hr) && ppv && *ppv) HookDxgiFactory(*ppv);
    return hr;
}

HRESULT WINAPI MyCreateDXGIFactory1(REFIID riid, void** ppv) {
    HRESULT hr = g_origCreateDXGIFactory1(riid, ppv);
    if (SUCCEEDED(hr) && ppv && *ppv) HookDxgiFactory(*ppv);
    return hr;
}

HRESULT WINAPI MyCreateDXGIFactory2(UINT flags, REFIID riid, void** ppv) {
    HRESULT hr = g_origCreateDXGIFactory2(flags, riid, ppv);
    if (SUCCEEDED(hr) && ppv && *ppv) HookDxgiFactory(*ppv);
    return hr;
}

template <typename Fn>
void* WrapProc(void* real, Fn hooked, Fn* origOut) {
    if (!real || real == (void*)hooked) return real;
    if (!*origOut) *origOut = (Fn)real;
    return (void*)hooked;
}

}  // namespace

void HookDxgiSwapChain(void* swapChain) {
    if (!swapChain) return;
    if (vtable::HookObject(swapChain, 8, &MyPresent, &g_origPresent) &&
        !Config().FrameSyncEnabled()) {
        Log("DXGI: hooked IDXGISwapChain::Present (vtable[8])");
    }
    if (vtable::HookObject(swapChain, 13, &MyResizeBuffers, &g_origResizeBuffers) &&
        !Config().FrameSyncEnabled()) {
        Log("DXGI: hooked IDXGISwapChain::ResizeBuffers (vtable[13])");
    }
    DispatchDevice(Api::kDxgi, swapChain);
}

void HookDxgiFactory(void* factory) {
    if (!factory) return;
    auto* f = (IDXGIFactory*)factory;
    if (vtable::HookObject(f, 10, &MyCreateSwapChain, &g_origCreateSwapChain) &&
        !Config().FrameSyncEnabled()) {
        Log("DXGI: hooked IDXGIFactory::CreateSwapChain (vtable[10])");
    }
    IDXGIFactory2* f2 = nullptr;
    if (SUCCEEDED(f->QueryInterface(kIID_IDXGIFactory2, (void**)&f2)) && f2) {
        if (vtable::HookObject(f2, 15, &MyCreateSwapChainForHwnd, &g_origCreateSwapChainForHwnd) &&
            !Config().FrameSyncEnabled()) {
            Log("DXGI: hooked IDXGIFactory2::CreateSwapChainForHwnd (vtable[15])");
        }
        f2->Release();
    }
}

void* WrapD3D11CreateDevice(void* real) {
    return WrapProc(real, &MyD3D11CreateDevice, &g_origD3D11CreateDevice);
}

void* WrapD3D11CreateDeviceAndSwapChain(void* real) {
    return WrapProc(real, &MyD3D11CreateDeviceAndSwapChain, &g_origD3D11CreateDeviceAndSwapChain);
}

void* WrapCreateDXGIFactory(void* real) {
    return WrapProc(real, &MyCreateDXGIFactory, &g_origCreateDXGIFactory);
}

void* WrapCreateDXGIFactory1(void* real) {
    return WrapProc(real, &MyCreateDXGIFactory1, &g_origCreateDXGIFactory1);
}

void* WrapCreateDXGIFactory2(void* real) {
    return WrapProc(real, &MyCreateDXGIFactory2, &g_origCreateDXGIFactory2);
}

}  // namespace autoplay::present
