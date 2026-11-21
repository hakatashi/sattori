#include "texture/d3dx_filter.h"
#include "texture/area_resample.h"
#include "core/log.h"
#include "core/pe_iat.h"
#include "core/runtime_config.h"

// 詳細は texture/d3dx_filter.h を参照(touhou-recorder reports/101・102)。

namespace autoplay {

namespace {

typedef HRESULT(WINAPI* LoadFromMemory_t)(void* dstSurf, const PALETTEENTRY* dstPal, const RECT* dstRect,
                                           const void* src, DWORD srcFmt, UINT srcPitch,
                                           const PALETTEENTRY* srcPal, const RECT* srcRect, DWORD filter,
                                           DWORD colorKey);

LoadFromMemory_t o_LoadFromMemory = nullptr;
volatile LONG g_filtered = 0;

// 縮小用の作業領域。転送は描画スレッドから1つずつ呼ばれる想定だが、念のため排他する
// (取れなければ元の関数へそのまま渡す)。
volatile LONG g_resampleBusy = 0;
area_resample::Resampler g_resampler;

// IDirect3DSurface9::GetDesc(vtable 12)が返す D3DSURFACE_DESC。
struct SurfDesc {
    DWORD Format, Type, Usage, Pool, MultiSampleType, MultiSampleQuality;
    UINT Width, Height;
};
typedef HRESULT(WINAPI* GetDesc_t)(void*, SurfDesc*);

bool GetSurfaceSize(void* surf, UINT* w, UINT* h, DWORD* fmt) {
    if (!surf) return false;
    SurfDesc d{};
    void** vt = *(void***)surf;
    if (FAILED(((GetDesc_t)vt[12])(surf, &d))) return false;
    *w = d.Width; *h = d.Height; *fmt = d.Format;
    return true;
}

const char* FmtName(DWORD f) {
    switch (f) {
        case 21: return "A8R8G8B8";
        case 22: return "X8R8G8B8";
        case 23: return "R5G6B5";
        case 24: return "X1R5G5B5";
        case 25: return "A1R5G5B5";
        case 26: return "A4R4G4B4";
        case 28: return "A8";
        case 30: return "X4R4G4B4";
        default: return "?";
    }
}

HRESULT WINAPI My_LoadFromMemory(void* dstSurf, const PALETTEENTRY* dstPal, const RECT* dstRect, const void* src,
                                 DWORD srcFmt, UINT srcPitch, const PALETTEENTRY* srcPal, const RECT* srcRect,
                                 DWORD filter, DWORD colorKey) {
    UINT tw = 0, th = 0;
    DWORD tfmt = 0;
    GetSurfaceSize(dstSurf, &tw, &th, &tfmt);
    RECT dr = dstRect ? *dstRect : RECT{0, 0, (LONG)tw, (LONG)th};
    RECT sr = srcRect ? *srcRect : RECT{0, 0, 0, 0};
    // D3DX_DEFAULT(0xFFFFFFFF) は D3DX_FILTER_TRIANGLE | D3DX_FILTER_DITHER と同じ扱い。
    DWORD ftype = (filter == 0xFFFFFFFFu) ? 4 : (filter & 0xF);
    UINT sw = sr.right - sr.left, sh = sr.bottom - sr.top;
    UINT dw = dr.right - dr.left, dh = dr.bottom - dr.top;
    int bpp = 0;
    bool scaled = srcRect && (sw != dw || sh != dh);
    bool mirror = filter != 0xFFFFFFFFu && (filter & 0x70000);
    if (scaled && sw >= dw && sh >= dh && dw > 0 && dh > 0 && ftype >= 3 && ftype <= 5 && !mirror && !srcPal &&
        area_resample::BytesPerPixel(srcFmt, &bpp)) {
        if (InterlockedExchange(&g_resampleBusy, 1))  // 別スレッドが使用中なら元の関数へ
            return o_LoadFromMemory(dstSurf, dstPal, dstRect, src, srcFmt, srcPitch, srcPal, srcRect, filter,
                                    colorKey);
        // 転送先が 4bit 形式ならその形式で、それ以外は A8R8G8B8 で作り、同じサイズ・FILTER_NONE で渡す。
        const DWORD outFmt = (tfmt == 26 || tfmt == 30) ? tfmt : 21;
        const BYTE* base = (const BYTE*)src + (size_t)sr.top * srcPitch + (size_t)sr.left * bpp;
        g_resampler.Run(base, srcPitch, srcFmt, bpp, sw, sh, colorKey, dw, dh, outFmt);
        RECT nr = {0, 0, (LONG)dw, (LONG)dh};
        HRESULT hr = o_LoadFromMemory(dstSurf, dstPal, dstRect, g_resampler.out.data(), outFmt, dw * (outFmt == 21 ? 4 : 2),
                                      nullptr, &nr, 1 /*D3DX_FILTER_NONE*/, 0);
        InterlockedExchange(&g_resampleBusy, 0);
        LONG n = InterlockedIncrement(&g_filtered);
        if (n <= 5 || (n % 500) == 0)
            Log("D3DXFilterHook: area-filtered %ux%u -> %ux%u (%s, filter=%#lx, radius=%.2f) hr=%#lx count=%ld", sw, sh,
                dw, dh, FmtName(srcFmt), filter, area_resample::kRadiusFactor, (unsigned long)hr, n);
        return hr;
    }
    return o_LoadFromMemory(dstSurf, dstPal, dstRect, src, srcFmt, srcPitch, srcPal, srcRect, filter, colorKey);
}

}  // namespace

int InstallD3DXFilterHook() {
    if (Config().d3dxAreaFilterDisabled) {
        Log("InstallD3DXFilterHook: disabled by D3DX_AREA_FILTER=0");
        return 0;
    }
    // th10 は d3dx9_31.dll、th13 は d3dx9_43.dll のようにタイトルごとにバージョンが違う。
    const char* matched = nullptr;
    int n = iat::Hook(nullptr, iat::DllPrefix{"d3dx9_"}, "D3DXLoadSurfaceFromMemory", (void*)My_LoadFromMemory,
                      (void**)&o_LoadFromMemory, &matched)
                ? 1
                : 0;
    if (n) Log("InstallD3DXFilterHook: hooked %s!%s", matched, "D3DXLoadSurfaceFromMemory");
    Log("InstallD3DXFilterHook: area_filter hooked=%d radius=%.2f", n, area_resample::kRadiusFactor);
    return n;
}

}  // namespace autoplay
