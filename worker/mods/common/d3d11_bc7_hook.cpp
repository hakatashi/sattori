// reports/96 を参照。D3D11CreateDevice系の戻り値のvtableを差し替え、BC7テクスチャの生成と
// 転送(初期データ、UpdateSubresource、ステージングのMap/Unmap)をRGBA8へ置き換える。
#include "d3d11_bc7_hook.h"

#include <d3d11.h>
#include <windows.h>

#include <map>
#include <mutex>
#include <set>
#include <vector>

#include "bc7_decode.h"
#include "logging.h"

using autoplay::Log;

namespace {

typedef HRESULT(WINAPI *CreateDevice_t)(IDXGIAdapter *, D3D_DRIVER_TYPE, HMODULE, UINT, const D3D_FEATURE_LEVEL *, UINT, UINT,
                                        ID3D11Device **, D3D_FEATURE_LEVEL *, ID3D11DeviceContext **);
typedef HRESULT(WINAPI *CreateDeviceAndSwapChain_t)(IDXGIAdapter *, D3D_DRIVER_TYPE, HMODULE, UINT, const D3D_FEATURE_LEVEL *, UINT, UINT,
                                                    const DXGI_SWAP_CHAIN_DESC *, IDXGISwapChain **, ID3D11Device **, D3D_FEATURE_LEVEL *,
                                                    ID3D11DeviceContext **);
typedef HRESULT(STDMETHODCALLTYPE *CreateTexture2D_t)(ID3D11Device *, const D3D11_TEXTURE2D_DESC *, const D3D11_SUBRESOURCE_DATA *, ID3D11Texture2D **);
typedef HRESULT(STDMETHODCALLTYPE *CreateSRV_t)(ID3D11Device *, ID3D11Resource *, const D3D11_SHADER_RESOURCE_VIEW_DESC *, ID3D11ShaderResourceView **);
typedef void(STDMETHODCALLTYPE *UpdateSubresource_t)(ID3D11DeviceContext *, ID3D11Resource *, UINT, const D3D11_BOX *, const void *, UINT, UINT);
typedef HRESULT(STDMETHODCALLTYPE *Map_t)(ID3D11DeviceContext *, ID3D11Resource *, UINT, D3D11_MAP, UINT, D3D11_MAPPED_SUBRESOURCE *);
typedef void(STDMETHODCALLTYPE *Unmap_t)(ID3D11DeviceContext *, ID3D11Resource *, UINT);

CreateDevice_t g_realCreateDevice;
CreateDeviceAndSwapChain_t g_realCreateDeviceAndSwapChain;
CreateTexture2D_t g_realCreateTexture2D;
CreateSRV_t g_realCreateSRV;
UpdateSubresource_t g_realUpdateSubresource;
Map_t g_realMap;
Unmap_t g_realUnmap;

std::mutex g_mutex;
std::set<void *> g_converted;  // RGBA8へ置き換えたテクスチャ
struct PendingMap { D3D11_MAPPED_SUBRESOURCE real; std::vector<uint8_t> shadow; UINT w, h; };
std::map<std::pair<void *, UINT>, PendingMap> g_pendingMaps;
long g_statTextures, g_statUpdates, g_statMaps;

bool Enabled() {
    static int cached = -1;
    if (cached < 0) {
        char b[8] = {0};
        GetEnvironmentVariableA("D3D11_DECODE_BC7", b, sizeof(b));
        cached = b[0] == '1';
    }
    return cached == 1;
}
DXGI_FORMAT Replacement(DXGI_FORMAT f) {
    switch (f) {
        case DXGI_FORMAT_BC7_TYPELESS: return DXGI_FORMAT_R8G8B8A8_TYPELESS;
        case DXGI_FORMAT_BC7_UNORM: return DXGI_FORMAT_R8G8B8A8_UNORM;
        case DXGI_FORMAT_BC7_UNORM_SRGB: return DXGI_FORMAT_R8G8B8A8_UNORM_SRGB;
        default: return DXGI_FORMAT_UNKNOWN;
    }
}
bool IsConverted(void *res) {
    std::lock_guard<std::mutex> lock(g_mutex);
    return g_converted.count(res) != 0;
}
UINT MipDim(UINT v, UINT mip) { UINT r = v >> mip; return r ? r : 1; }

HRESULT STDMETHODCALLTYPE MyCreateTexture2D(ID3D11Device *self, const D3D11_TEXTURE2D_DESC *desc, const D3D11_SUBRESOURCE_DATA *init, ID3D11Texture2D **out) {
    DXGI_FORMAT rep = desc ? Replacement(desc->Format) : DXGI_FORMAT_UNKNOWN;
    if (rep == DXGI_FORMAT_UNKNOWN) {
        HRESULT hr = g_realCreateTexture2D(self, desc, init, out);
        if (SUCCEEDED(hr) && out && *out) {
            std::lock_guard<std::mutex> lock(g_mutex);
            g_converted.erase(*out);  // 解放済みアドレスの再利用
        }
        return hr;
    }
    D3D11_TEXTURE2D_DESC d = *desc;
    d.Format = rep;
    UINT mips = d.MipLevels ? d.MipLevels : 1, subCount = mips * d.ArraySize;
    std::vector<std::vector<uint8_t>> buffers;
    std::vector<D3D11_SUBRESOURCE_DATA> data;
    if (init) {
        buffers.resize(subCount);
        data.resize(subCount);
        for (UINT s = 0; s < subCount; s++) {
            UINT mip = s % mips, w = MipDim(d.Width, mip), h = MipDim(d.Height, mip);
            buffers[s].resize(w * h * 4);
            bc7::DecodeImage((const uint8_t *)init[s].pSysMem, init[s].SysMemPitch, w, h, buffers[s].data(), w * 4);
            data[s].pSysMem = buffers[s].data();
            data[s].SysMemPitch = w * 4;
            data[s].SysMemSlicePitch = w * h * 4;
        }
    }
    HRESULT hr = g_realCreateTexture2D(self, &d, init ? data.data() : nullptr, out);
    long n = InterlockedIncrement(&g_statTextures);
    Log("D3D11BC7: CreateTexture2D #%ld %ux%u mips=%u usage=%d init=%d hr=0x%08lx", n, d.Width, d.Height, mips, (int)d.Usage, init != nullptr, (unsigned long)hr);
    if (SUCCEEDED(hr) && out && *out) {
        std::lock_guard<std::mutex> lock(g_mutex);
        g_converted.insert(*out);
    }
    return hr;
}

HRESULT STDMETHODCALLTYPE MyCreateSRV(ID3D11Device *self, ID3D11Resource *res, const D3D11_SHADER_RESOURCE_VIEW_DESC *desc, ID3D11ShaderResourceView **out) {
    if (desc && Replacement(desc->Format) != DXGI_FORMAT_UNKNOWN && IsConverted(res)) {
        D3D11_SHADER_RESOURCE_VIEW_DESC d = *desc;
        d.Format = Replacement(desc->Format);
        return g_realCreateSRV(self, res, &d, out);
    }
    return g_realCreateSRV(self, res, desc, out);
}

bool GetTextureDims(ID3D11Resource *res, UINT sub, UINT *w, UINT *h) {
    ID3D11Texture2D *tex = nullptr;
    if (FAILED(res->QueryInterface(__uuidof(ID3D11Texture2D), (void **)&tex)) || !tex) return false;
    D3D11_TEXTURE2D_DESC d;
    tex->GetDesc(&d);
    tex->Release();
    UINT mip = sub % (d.MipLevels ? d.MipLevels : 1);
    *w = MipDim(d.Width, mip);
    *h = MipDim(d.Height, mip);
    return true;
}

void STDMETHODCALLTYPE MyUpdateSubresource(ID3D11DeviceContext *self, ID3D11Resource *res, UINT sub, const D3D11_BOX *box, const void *src, UINT rowPitch, UINT depthPitch) {
    if (!IsConverted(res)) { g_realUpdateSubresource(self, res, sub, box, src, rowPitch, depthPitch); return; }
    UINT w, h;
    if (box) { w = box->right - box->left; h = box->bottom - box->top; }
    else if (!GetTextureDims(res, sub, &w, &h)) return;
    std::vector<uint8_t> buf(w * h * 4);
    bc7::DecodeImage((const uint8_t *)src, rowPitch, w, h, buf.data(), w * 4);
    if (InterlockedIncrement(&g_statUpdates) <= 8) Log("D3D11BC7: UpdateSubresource sub=%u %ux%u box=%d", sub, w, h, box != nullptr);
    g_realUpdateSubresource(self, res, sub, box, buf.data(), w * 4, w * h * 4);
}

HRESULT STDMETHODCALLTYPE MyMap(ID3D11DeviceContext *self, ID3D11Resource *res, UINT sub, D3D11_MAP type, UINT flags, D3D11_MAPPED_SUBRESOURCE *out) {
    HRESULT hr = g_realMap(self, res, sub, type, flags, out);
    if (FAILED(hr) || !out || !IsConverted(res)) return hr;
    UINT w, h;
    if (!GetTextureDims(res, sub, &w, &h)) return hr;
    // ゲームにはBC7のレイアウトの一時バッファを見せ、Unmap時に展開して本来のメモリへ書く。
    PendingMap pm;
    pm.real = *out;
    pm.w = w;
    pm.h = h;
    UINT pitch = ((w + 3) / 4) * 16, rows = (h + 3) / 4;
    pm.shadow.assign(pitch * rows, 0);
    out->pData = pm.shadow.data();
    out->RowPitch = pitch;
    out->DepthPitch = pitch * rows;
    if (InterlockedIncrement(&g_statMaps) <= 8) Log("D3D11BC7: Map sub=%u %ux%u type=%d", sub, w, h, (int)type);
    std::lock_guard<std::mutex> lock(g_mutex);
    PendingMap &slot = g_pendingMaps[{res, sub}];
    slot = std::move(pm);
    out->pData = slot.shadow.data();
    return hr;
}

void STDMETHODCALLTYPE MyUnmap(ID3D11DeviceContext *self, ID3D11Resource *res, UINT sub) {
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        auto it = g_pendingMaps.find({res, sub});
        if (it != g_pendingMaps.end()) {
            PendingMap &pm = it->second;
            bc7::DecodeImage(pm.shadow.data(), ((pm.w + 3) / 4) * 16, pm.w, pm.h, (uint8_t *)pm.real.pData, pm.real.RowPitch);
            g_pendingMaps.erase(it);
        }
    }
    g_realUnmap(self, res, sub);
}

void PatchVtable(void *obj, int index, void *hook, void **orig) {
    void **vtable = *(void ***)obj;
    if (vtable[index] == hook) return;
    DWORD old;
    VirtualProtect(&vtable[index], sizeof(void *), PAGE_EXECUTE_READWRITE, &old);
    *orig = vtable[index];
    vtable[index] = hook;
    VirtualProtect(&vtable[index], sizeof(void *), old, &old);
}

void InstallDeviceHooks(ID3D11Device *dev, ID3D11DeviceContext *ctx) {
    if (dev) {
        PatchVtable(dev, 5, (void *)MyCreateTexture2D, (void **)&g_realCreateTexture2D);
        PatchVtable(dev, 7, (void *)MyCreateSRV, (void **)&g_realCreateSRV);
    }
    if (ctx) {
        PatchVtable(ctx, 14, (void *)MyMap, (void **)&g_realMap);
        PatchVtable(ctx, 15, (void *)MyUnmap, (void **)&g_realUnmap);
        PatchVtable(ctx, 48, (void *)MyUpdateSubresource, (void **)&g_realUpdateSubresource);
    }
    Log("D3D11BC7: デバイスをフックしました (dev=%p ctx=%p)", dev, ctx);
}

HRESULT WINAPI MyCreateDevice(IDXGIAdapter *a, D3D_DRIVER_TYPE t, HMODULE m, UINT f, const D3D_FEATURE_LEVEL *l, UINT n, UINT v,
                              ID3D11Device **dev, D3D_FEATURE_LEVEL *fl, ID3D11DeviceContext **ctx) {
    ID3D11Device *d = nullptr;
    ID3D11DeviceContext *c = nullptr;
    HRESULT hr = g_realCreateDevice(a, t, m, f, l, n, v, dev ? dev : &d, fl, ctx ? ctx : &c);
    if (SUCCEEDED(hr)) InstallDeviceHooks(dev ? *dev : d, ctx ? *ctx : c);
    if (d) d->Release();
    if (c) c->Release();
    return hr;
}
HRESULT WINAPI MyCreateDeviceAndSwapChain(IDXGIAdapter *a, D3D_DRIVER_TYPE t, HMODULE m, UINT f, const D3D_FEATURE_LEVEL *l, UINT n, UINT v,
                                          const DXGI_SWAP_CHAIN_DESC *sd, IDXGISwapChain **sc, ID3D11Device **dev, D3D_FEATURE_LEVEL *fl, ID3D11DeviceContext **ctx) {
    ID3D11Device *d = nullptr;
    ID3D11DeviceContext *c = nullptr;
    HRESULT hr = g_realCreateDeviceAndSwapChain(a, t, m, f, l, n, v, sd, sc, dev ? dev : &d, fl, ctx ? ctx : &c);
    if (SUCCEEDED(hr)) InstallDeviceHooks(dev ? *dev : d, ctx ? *ctx : c);
    if (d) d->Release();
    if (c) c->Release();
    return hr;
}

}  // namespace

void *WrapD3D11CreateDevice(void *real) {
    if (!Enabled() || !real) return real;
    g_realCreateDevice = (CreateDevice_t)real;
    return (void *)MyCreateDevice;
}
void *WrapD3D11CreateDeviceAndSwapChain(void *real) {
    if (!Enabled() || !real) return real;
    g_realCreateDeviceAndSwapChain = (CreateDeviceAndSwapChain_t)real;
    return (void *)MyCreateDeviceAndSwapChain;
}
