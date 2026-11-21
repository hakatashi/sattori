// Direct3D9の描画内容を記録する診断用フック(reports/99)。説明はd3d9_probe_hook.hを参照。
#include "d3d9_probe_hook.h"
#include "logging.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <algorithm>
#include <map>
#include <string>
#include <vector>

namespace autoplay {

namespace {

// ---- 素の型(DirectX SDKヘッダを使わない方針、fps_limiter_hook.cppと同じ) ----
struct SurfDesc {  // D3DSURFACE_DESC
    DWORD Format, Type, Usage, Pool, MultiSampleType, MultiSampleQuality, Width, Height;
};
typedef ULONG(WINAPI* Release_t)(void*);
typedef HRESULT(WINAPI* GetDesc_t)(void* surf, SurfDesc* d);             // IDirect3DSurface9[12]
typedef HRESULT(WINAPI* GetLevelDesc_t)(void* tex, UINT lv, SurfDesc* d);  // IDirect3DTexture9[17]
typedef DWORD(WINAPI* GetType_t)(void* res);                               // IDirect3DResource9[10]
typedef HRESULT(WINAPI* CreateQuery_t)(void* dev, DWORD type, void** q);   // device[118]
typedef HRESULT(WINAPI* QIssue_t)(void* q, DWORD flags);                   // IDirect3DQuery9[6]
typedef HRESULT(WINAPI* QGetData_t)(void* q, void* data, DWORD size, DWORD flags);  // [7]
typedef HRESULT(WINAPI* GetRenderTarget_t)(void* dev, DWORD idx, void** surf);      // device[38]

typedef HRESULT(WINAPI* Present_t)(void*, const void*, const void*, HWND, const void*);
typedef HRESULT(WINAPI* CreateTexture_t)(void*, UINT, UINT, UINT, DWORD, DWORD, DWORD, void**, HANDLE*);
typedef HRESULT(WINAPI* CreateVB_t)(void*, UINT, DWORD, DWORD, DWORD, void**, HANDLE*);
typedef HRESULT(WINAPI* CreateRT_t)(void*, UINT, UINT, DWORD, DWORD, DWORD, BOOL, void**, HANDLE*);
typedef HRESULT(WINAPI* StretchRect_t)(void*, void*, const RECT*, void*, const RECT*, DWORD);
typedef HRESULT(WINAPI* ColorFill_t)(void*, void*, const RECT*, DWORD);
typedef HRESULT(WINAPI* SetRenderTarget_t)(void*, DWORD, void*);
typedef HRESULT(WINAPI* Clear_t)(void*, DWORD, const void*, DWORD, DWORD, float, DWORD);
typedef HRESULT(WINAPI* SetRenderState_t)(void*, DWORD, DWORD);
typedef HRESULT(WINAPI* SetTexture_t)(void*, DWORD, void*);
typedef HRESULT(WINAPI* SetSamplerState_t)(void*, DWORD, DWORD, DWORD);
typedef HRESULT(WINAPI* SetPtr_t)(void*, void*);
typedef HRESULT(WINAPI* SetFVF_t)(void*, DWORD);
typedef HRESULT(WINAPI* SetTSS_t)(void*, DWORD, DWORD, DWORD);
typedef HRESULT(WINAPI* SetViewport_t)(void*, const void*);
typedef HRESULT(WINAPI* GetSurfaceLevel_t)(void* tex, UINT lv, void** surf);  // IDirect3DTexture9[18]
typedef HRESULT(WINAPI* DrawPrimitive_t)(void*, DWORD, UINT, UINT);
typedef HRESULT(WINAPI* DrawIndexedPrimitive_t)(void*, DWORD, INT, UINT, UINT, UINT, UINT);
typedef HRESULT(WINAPI* DrawPrimitiveUP_t)(void*, DWORD, UINT, const void*, UINT);
typedef HRESULT(WINAPI* DrawIndexedPrimitiveUP_t)(void*, DWORD, UINT, UINT, UINT, const void*, DWORD, const void*, UINT);

Present_t o_Present;
CreateTexture_t o_CreateTexture;
CreateVB_t o_CreateVB;
CreateRT_t o_CreateRT, o_CreateDS;
StretchRect_t o_StretchRect;
ColorFill_t o_ColorFill;
SetRenderTarget_t o_SetRenderTarget;
Clear_t o_Clear;
SetRenderState_t o_SetRenderState;
SetTexture_t o_SetTexture;
SetSamplerState_t o_SetSamplerState;
SetPtr_t o_SetPixelShader, o_SetVertexShader, o_SetVertexDecl;
SetFVF_t o_SetFVF;
SetTSS_t o_SetTSS;
SetViewport_t o_SetViewport;
DrawPrimitive_t o_DrawPrimitive;
DrawIndexedPrimitive_t o_DrawIndexedPrimitive;
DrawPrimitiveUP_t o_DrawPrimitiveUP;
DrawIndexedPrimitiveUP_t o_DrawIndexedPrimitiveUP;
CreateQuery_t o_CreateQuery;

void** vt(void* p) { return *(void***)p; }

void Patch(void** vtable, int idx, void* fn, void** old) {
    if (vtable[idx] == fn) return;
    DWORD prot;
    VirtualProtect(&vtable[idx], sizeof(void*), PAGE_EXECUTE_READWRITE, &prot);
    *old = vtable[idx];
    vtable[idx] = fn;
    VirtualProtect(&vtable[idx], sizeof(void*), prot, &prot);
}

const char* FmtName(DWORD f) {
    static char buf[16];
    switch (f) {
        case 21: return "A8R8G8B8";
        case 22: return "X8R8G8B8";
        case 23: return "R5G6B5";
        case 25: return "A1R5G5B5";
        case 26: return "A4R4G4B4";
        case 28: return "A8";
        case 32: return "A8B8G8R8";
        case 75: return "D24S8";
        case 77: return "D24X8";
        case 80: return "D16";
        case 113: return "A16B16G16R16F";
        case 114: return "R32F";
        case 116: return "A32B32G32R32F";
        case 0x31545844: return "DXT1";
        case 0x33545844: return "DXT3";
        case 0x35545844: return "DXT5";
        case 0: return "none";
    }
    snprintf(buf, sizeof(buf), "fmt%lu", (unsigned long)f);
    return buf;
}

// ---- 状態 ----
struct TexInfo { DWORD fmt = 0, w = 0, h = 0, usage = 0, pool = 0; void* ptr = nullptr; };
DWORD g_rtW = 0, g_rtH = 0, g_rtFmt = 0;
TexInfo g_tex0;
DWORD g_blend = 0, g_src = 2, g_dst = 1, g_blendOp = 1, g_alphaTest = 0, g_zEnable = 0, g_fvf = 0;
DWORD g_minFilter = 1, g_magFilter = 1;
DWORD g_zWrite = 1, g_zFunc = 4, g_colorWrite = 0xF;
long g_promoted = 0;  // D3D9_PROMOTE_A4R4G4B4で格上げした数
DWORD g_stencil = 0;
DWORD g_sepAlpha = 0, g_srcA = 2, g_dstA = 1;  // SEPARATEALPHABLENDENABLE / SRCBLENDALPHA / DESTBLENDALPHA
// 実験(reports/99): D3D9_SKIP_NOOP=1 で色も深度も変えない描画を省く、D3D9_ZTRIM=1 で
// 比較がALWAYSかつ書き込みなしの深度テスト(何もしない)をデバイスへ渡さない。
bool g_skipNoop = false, g_zTrim = false, g_probeLog = false, g_copyToBlit = false;
// D3D9_COPY_TO_BLIT=1(reports/99): レンダーテクスチャを等倍で貼るだけの描画をStretchRectへ置き換える。
DWORD g_tss0[7] = {0, 4, 2, 1, 2, 2, 1};  // stage0: -, COLOROP, COLORARG1, COLORARG2, ALPHAOP, ALPHAARG1, ALPHAARG2
DWORD g_tss1ColorOp = 1;                   // stage1 COLOROP(DISABLE)
DWORD g_fog = 0, g_scissor = 0;
struct Viewport { DWORD x, y, w, h; float mn, mx; } g_vp = {0, 0, 0, 0, 0.f, 1.f};
bool g_vpSet = false;
unsigned long g_blitted = 0, g_blitRejected = 0;
unsigned long g_skipped = 0;
DWORD g_effZ = 0xFFFFFFFF;  // ZTRIM時にデバイスへ実際に渡したZENABLE
bool g_ps = false, g_vs = false;

// 1フレーム分の集計
struct Counter { unsigned long draws = 0, prims = 0, verts = 0; };
Counter g_frame[4];  // DrawPrimitive, DrawIndexedPrimitive, DrawPrimitiveUP, DrawIndexedPrimitiveUP
unsigned long g_clears = 0, g_stretch = 0, g_setRT = 0, g_setTex = 0, g_colorFill = 0;
unsigned long long g_stretchPix = 0, g_clearPix = 0;

// 集計窓(SUMMARY_FRAMES)の合計
Counter g_win[4];
unsigned long g_winClears = 0, g_winStretch = 0, g_winSetRT = 0, g_winSetTex = 0;
unsigned long long g_winStretchPix = 0, g_winClearPix = 0;
unsigned long g_frameNo = 0, g_winFrames = 0;
unsigned long g_summaryFrames = 300, g_dumpEvery = 1800;

// 詳細記録フレーム
bool g_dumping = false;
void* g_device = nullptr;
struct DrawRec { std::string key; unsigned long prims; void* q; };
std::vector<DrawRec> g_recs;
std::vector<void*> g_queryPool;
size_t g_queryUsed = 0;

void* GetQuery() {
    if (g_queryUsed < g_queryPool.size()) return g_queryPool[g_queryUsed++];
    void* q = nullptr;
    if (FAILED(o_CreateQuery(g_device, 9 /*D3DQUERYTYPE_OCCLUSION*/, &q)) || !q) return nullptr;
    g_queryPool.push_back(q);
    g_queryUsed++;
    return q;
}

std::string StateKey(int kind, DWORD primType) {
    char b[256];
    snprintf(b, sizeof(b), "rt=%lux%lu/%s tex=%s/%lux%lu blend=%lu(%lu,%lu,op%lu)a%lu(%lu,%lu) at=%lu z=%lu/w%lu/f%lu cw=%lx ps=%d vs=%d fvf=%#lx filt=%lu/%lu call=%d prim=%lu",
             g_rtW, g_rtH, FmtName(g_rtFmt), FmtName(g_tex0.fmt), g_tex0.w, g_tex0.h, g_blend, g_src, g_dst,
             g_blendOp, g_sepAlpha, g_srcA, g_dstA, g_alphaTest, g_zEnable, g_zWrite, g_zFunc, (unsigned long)g_colorWrite, g_ps ? 1 : 0, g_vs ? 1 : 0, (unsigned long)g_fvf,
             g_minFilter, g_magFilter, kind, primType);
    return b;
}

unsigned long Verts(DWORD primType, UINT count) {
    switch (primType) {
        case 1: return count;          // POINTLIST
        case 2: return count * 2;      // LINELIST
        case 3: return count + 1;      // LINESTRIP
        case 4: return count * 3;      // TRIANGLELIST
        case 5: case 6: return count + 2;  // STRIP / FAN
    }
    return count;
}

// ブレンドが dst = src*0 + dst*1 で、深度も書かず、ステンシルも使わない描画は画面を変えない。
// アルファを別のブレンド係数で書く(SEPARATEALPHABLENDENABLE)場合は、後の描画がDESTALPHAで
// 使うマスクを書いているので空ではない(当初これを見落とし、th15の画面が崩れた、reports/99)。
bool IsNoop() {
    bool colorNoop = g_blend && g_src == 1 /*ZERO*/ && g_dst == 2 /*ONE*/ && g_blendOp == 1 /*ADD*/;
    bool alphaNoop = !g_sepAlpha || (g_srcA == 1 && g_dstA == 2) || !(g_colorWrite & 8);
    return colorNoop && alphaNoop && !(g_zEnable && g_zWrite) && !g_stencil;
}

template <class F>
HRESULT Draw(int kind, DWORD primType, UINT count, F call) {
    if (g_skipNoop && IsNoop()) { g_skipped++; return S_OK; }
    g_frame[kind].draws++;
    g_frame[kind].prims += count;
    g_frame[kind].verts += Verts(primType, count);
    if (!g_dumping) return call();
    void* q = GetQuery();
    if (q) ((QIssue_t)vt(q)[6])(q, 2 /*BEGIN*/);
    HRESULT hr = call();
    if (q) ((QIssue_t)vt(q)[6])(q, 1 /*END*/);
    g_recs.push_back({StateKey(kind, primType), count, q});
    return hr;
}

void UpdateRT(void* surf) {
    if (!surf) return;
    SurfDesc d{};
    if (SUCCEEDED(((GetDesc_t)vt(surf)[12])(surf, &d))) {
        g_rtW = d.Width; g_rtH = d.Height; g_rtFmt = d.Format;
    }
}

void FinishDump() {
    struct Agg { unsigned long draws = 0, prims = 0; unsigned long long samples = 0; };
    std::map<std::string, Agg> agg;
    unsigned long long total = 0;
    for (auto& r : g_recs) {
        DWORD s = 0;
        if (r.q) {
            for (int i = 0; i < 200000; i++) {
                HRESULT hr = ((QGetData_t)vt(r.q)[7])(r.q, &s, sizeof(s), 1 /*FLUSH*/);
                if (hr == S_OK) break;
                if (FAILED(hr)) { s = 0; break; }
            }
        }
        Agg& a = agg[r.key];
        a.draws++; a.prims += r.prims; a.samples += s;
        total += s;
    }
    Log("D3D9Probe: DUMP frame=%lu draws=%u samples=%llu (%.2f x 1280x960) groups=%u",
        g_frameNo, (unsigned)g_recs.size(), total, total / (1280.0 * 960.0), (unsigned)agg.size());
    std::vector<std::pair<unsigned long long, std::string>> order;
    for (auto& kv : agg) {
        char b[96];
        snprintf(b, sizeof(b), " draws=%lu prims=%lu samples=%llu", kv.second.draws, kv.second.prims, kv.second.samples);
        order.push_back({kv.second.samples, kv.first + b});
    }
    std::sort(order.begin(), order.end(), [](auto& a, auto& b) { return a.first > b.first; });
    for (auto& o : order) Log("D3D9Probe:   %s", o.second.c_str());
    // 描画順の列(状態が変わったところだけ)。何がどの順で描かれているかを見る。
    std::string prev;
    int run = 0, idx = 0;
    for (auto& r : g_recs) {
        if (r.key != prev && run) { Log("D3D9Probe:   seq x%d %s", run, prev.c_str()); run = 0; }
        prev = r.key; run++; idx++;
        if (idx > 4000) break;
    }
    if (run) Log("D3D9Probe:   seq x%d %s", run, prev.c_str());
    g_recs.clear();
    g_queryUsed = 0;
}

// ---- フック ----
HRESULT WINAPI My_Present(void* dev, const void* a, const void* b, HWND c, const void* d) {
    if (g_dumping) { FinishDump(); g_dumping = false; }
    for (int i = 0; i < 4; i++) {
        g_win[i].draws += g_frame[i].draws; g_win[i].prims += g_frame[i].prims; g_win[i].verts += g_frame[i].verts;
        g_frame[i] = Counter();
    }
    g_winClears += g_clears; g_winStretch += g_stretch; g_winSetRT += g_setRT; g_winSetTex += g_setTex;
    g_winStretchPix += g_stretchPix; g_winClearPix += g_clearPix;
    g_clears = g_stretch = g_setRT = g_setTex = g_colorFill = 0; g_stretchPix = g_clearPix = 0;
    g_frameNo++; g_winFrames++;
    if (g_winFrames >= g_summaryFrames && !g_probeLog) {
        if (g_skipNoop) Log("D3D9Probe: frame=%lu skipped_noop=%lu (total)", g_frameNo, g_skipped);
        if (g_copyToBlit) Log("D3D9Probe: frame=%lu copy_to_blit=%lu rejected=%lu (total)", g_frameNo, g_blitted, g_blitRejected);
        g_winFrames = 0;
    }
    if (g_winFrames >= g_summaryFrames) {
        double n = (double)g_winFrames;
        Log("D3D9Probe: frame=%lu per-frame DP=%.1f(%.0fprim) DIP=%.1f(%.0fprim) DPUP=%.1f(%.0fprim,%.0fv) DIPUP=%.1f(%.0fprim) clear=%.1f(%.2fMpix) stretch=%.1f(%.2fMpix) setRT=%.1f setTex=%.1f promoted=%ld",
            g_frameNo, g_win[0].draws / n, g_win[0].prims / n, g_win[1].draws / n, g_win[1].prims / n,
            g_win[2].draws / n, g_win[2].prims / n, g_win[2].verts / n, g_win[3].draws / n, g_win[3].prims / n,
            g_winClears / n, g_winClearPix / n / 1e6, g_winStretch / n, g_winStretchPix / n / 1e6,
            g_winSetRT / n, g_winSetTex / n, g_promoted);
        for (int i = 0; i < 4; i++) g_win[i] = Counter();
        g_winClears = g_winStretch = g_winSetRT = g_winSetTex = 0; g_winStretchPix = g_winClearPix = 0;
        g_winFrames = 0;
    }
    HRESULT hr = o_Present(dev, a, b, c, d);
    if (g_dumpEvery && g_frameNo % g_dumpEvery == 0) g_dumping = true;
    return hr;
}

HRESULT WINAPI My_CreateTexture(void* dev, UINT w, UINT h, UINT lv, DWORD usage, DWORD fmt, DWORD pool, void** t, HANDLE* sh) {
    HRESULT hr = o_CreateTexture(dev, w, h, lv, usage, fmt, pool, t, sh);
    if (g_probeLog) Log("D3D9Probe: CreateTexture %ux%u lv=%u usage=%#lx fmt=%s pool=%lu hr=%#lx", w, h, lv, usage, FmtName(fmt), pool, (unsigned long)hr);
    return hr;
}
HRESULT WINAPI My_CreateVB(void* dev, UINT len, DWORD usage, DWORD fvf, DWORD pool, void** vb, HANDLE* sh) {
    HRESULT hr = o_CreateVB(dev, len, usage, fvf, pool, vb, sh);
    Log("D3D9Probe: CreateVertexBuffer len=%u usage=%#lx fvf=%#lx pool=%lu", len, usage, fvf, pool);
    return hr;
}
HRESULT WINAPI My_CreateRT(void* dev, UINT w, UINT h, DWORD fmt, DWORD ms, DWORD mq, BOOL lock, void** s, HANDLE* sh) {
    HRESULT hr = o_CreateRT(dev, w, h, fmt, ms, mq, lock, s, sh);
    Log("D3D9Probe: CreateRenderTarget %ux%u fmt=%s ms=%lu lockable=%d", w, h, FmtName(fmt), ms, lock);
    return hr;
}
HRESULT WINAPI My_CreateDS(void* dev, UINT w, UINT h, DWORD fmt, DWORD ms, DWORD mq, BOOL discard, void** s, HANDLE* sh) {
    HRESULT hr = o_CreateDS(dev, w, h, fmt, ms, mq, discard, s, sh);
    Log("D3D9Probe: CreateDepthStencilSurface %ux%u fmt=%s ms=%lu", w, h, FmtName(fmt), ms);
    return hr;
}
HRESULT WINAPI My_StretchRect(void* dev, void* src, const RECT* sr, void* dst, const RECT* dr, DWORD filt) {
    g_stretch++;
    SurfDesc d{};
    if (dst && SUCCEEDED(((GetDesc_t)vt(dst)[12])(dst, &d))) {
        g_stretchPix += dr ? (unsigned long long)(dr->right - dr->left) * (dr->bottom - dr->top)
                           : (unsigned long long)d.Width * d.Height;
    }
    if (g_dumping) {
        SurfDesc s{};
        if (src) ((GetDesc_t)vt(src)[12])(src, &s);
        Log("D3D9Probe:   StretchRect %lux%lu/%s -> %lux%lu/%s filter=%lu", s.Width, s.Height, FmtName(s.Format),
            d.Width, d.Height, FmtName(d.Format), filt);
    }
    return o_StretchRect(dev, src, sr, dst, dr, filt);
}
HRESULT WINAPI My_ColorFill(void* dev, void* s, const RECT* r, DWORD c) { g_colorFill++; return o_ColorFill(dev, s, r, c); }
HRESULT WINAPI My_SetRenderTarget(void* dev, DWORD idx, void* s) {
    g_setRT++;
    HRESULT hr = o_SetRenderTarget(dev, idx, s);
    if (idx == 0) UpdateRT(s);
    return hr;
}
HRESULT WINAPI My_Clear(void* dev, DWORD n, const void* rects, DWORD flags, DWORD color, float z, DWORD st) {
    g_clears++;
    g_clearPix += (unsigned long long)g_rtW * g_rtH;
    if (g_dumping) {
        const RECT* r = (const RECT*)rects;  // D3DRECTはRECTと同じ配置(x1,y1,x2,y2)
        if (n && r)
            Log("D3D9Probe:   Clear rt=%lux%lu flags=%#lx rects=%lu first=(%ld,%ld)-(%ld,%ld) color=%#lx z=%.2f",
                g_rtW, g_rtH, flags, n, r->left, r->top, r->right, r->bottom, color, z);
        else
            Log("D3D9Probe:   Clear rt=%lux%lu flags=%#lx rects=0 color=%#lx z=%.2f", g_rtW, g_rtH, flags, color, z);
    }
    return o_Clear(dev, n, rects, flags, color, z, st);
}
HRESULT WINAPI My_SetRenderState(void* dev, DWORD st, DWORD v) {
    switch (st) {
        case 27: g_blend = v; break;      // ALPHABLENDENABLE
        case 19: g_src = v; break;        // SRCBLEND
        case 20: g_dst = v; break;        // DESTBLEND
        case 171: g_blendOp = v; break;   // BLENDOP
        case 15: g_alphaTest = v; break;  // ALPHATESTENABLE
        case 7: g_zEnable = v; break;     // ZENABLE
        case 14: g_zWrite = v; break;     // ZWRITEENABLE
        case 23: g_zFunc = v; break;      // ZFUNC
        case 168: g_colorWrite = v; break;  // COLORWRITEENABLE
        case 52: g_stencil = v; break;    // STENCILENABLE
        case 206: g_sepAlpha = v; break;  // SEPARATEALPHABLENDENABLE
        case 207: g_srcA = v; break;      // SRCBLENDALPHA
        case 208: g_dstA = v; break;      // DESTBLENDALPHA
        case 28: g_fog = v; break;        // FOGENABLE
        case 174: g_scissor = v; break;   // SCISSORTESTENABLE
    }
    if (g_zTrim && (st == 7 || st == 14 || st == 23 || st == 52)) {
        DWORD eff = (g_zEnable && !(g_zFunc == 8 /*ALWAYS*/ && !g_zWrite && !g_stencil)) ? g_zEnable : 0;
        HRESULT hr = S_OK;
        if (st != 7) hr = o_SetRenderState(dev, st, v);
        if (eff != g_effZ) { o_SetRenderState(dev, 7, eff); g_effZ = eff; }
        return hr;
    }
    return o_SetRenderState(dev, st, v);
}
HRESULT WINAPI My_SetTexture(void* dev, DWORD stage, void* tex) {
    g_setTex++;
    if (stage == 0) {
        g_tex0 = TexInfo();
        if (tex && ((GetType_t)vt(tex)[10])(tex) == 3 /*D3DRTYPE_TEXTURE*/) {
            SurfDesc d{};
            if (SUCCEEDED(((GetLevelDesc_t)vt(tex)[17])(tex, 0, &d))) {
                g_tex0.fmt = d.Format; g_tex0.w = d.Width; g_tex0.h = d.Height;
                g_tex0.usage = d.Usage; g_tex0.pool = d.Pool; g_tex0.ptr = tex;
            }
        } else if (tex) {
            g_tex0.fmt = 0xFFFFFFFF;
        }
    }
    return o_SetTexture(dev, stage, tex);
}
HRESULT WINAPI My_SetSamplerState(void* dev, DWORD s, DWORD t, DWORD v) {
    if (s == 0) { if (t == 6) g_minFilter = v; else if (t == 5) g_magFilter = v; }
    return o_SetSamplerState(dev, s, t, v);
}
HRESULT WINAPI My_SetPixelShader(void* dev, void* ps) { g_ps = ps != nullptr; return o_SetPixelShader(dev, ps); }
HRESULT WINAPI My_SetVertexShader(void* dev, void* vs) { g_vs = vs != nullptr; return o_SetVertexShader(dev, vs); }
HRESULT WINAPI My_SetFVF(void* dev, DWORD fvf) { g_fvf = fvf; return o_SetFVF(dev, fvf); }
HRESULT WINAPI My_SetVertexDecl(void* dev, void* decl) { if (decl) g_fvf = 0xDEC1; return o_SetVertexDecl(dev, decl); }
HRESULT WINAPI My_DrawPrimitive(void* dev, DWORD pt, UINT sv, UINT pc) {
    return Draw(0, pt, pc, [&] { return o_DrawPrimitive(dev, pt, sv, pc); });
}
HRESULT WINAPI My_DrawIndexedPrimitive(void* dev, DWORD pt, INT bv, UINT mi, UINT nv, UINT si, UINT pc) {
    return Draw(1, pt, pc, [&] { return o_DrawIndexedPrimitive(dev, pt, bv, mi, nv, si, pc); });
}
HRESULT WINAPI My_SetTSS(void* dev, DWORD stage, DWORD type, DWORD v) {
    if (stage == 0 && type >= 1 && type <= 6) g_tss0[type] = v;
    if (stage == 1 && type == 1) g_tss1ColorOp = v;
    return o_SetTSS(dev, stage, type, v);
}
HRESULT WINAPI My_SetViewport(void* dev, const void* vp) {
    if (vp) { memcpy(&g_vp, vp, sizeof(g_vp)); g_vpSet = true; }
    return o_SetViewport(dev, vp);
}

// 段0の色・アルファがテクスチャそのもの(頂点色が白なのでMODULATEも恒等)になるか。
bool StageIsTexture(DWORD op, DWORD a1, DWORD a2) {
    const DWORD TEX = 2, CUR = 1, DIFF = 0;
    if (op == 2 /*SELECTARG1*/) return a1 == TEX;
    if (op == 3 /*SELECTARG2*/) return a2 == TEX;
    if (op == 4 /*MODULATE*/) return (a1 == TEX && (a2 == CUR || a2 == DIFF)) || (a2 == TEX && (a1 == CUR || a1 == DIFF));
    return false;
}

// レンダーテクスチャを点サンプリング・等倍で長方形に貼るだけの描画なら、StretchRectで済ませる。
// 条件を一つでも外れたら何もしない(元の描画をそのまま行う)。
bool TryCopyAsBlit(void* dev, DWORD pt, UINT pc, const void* data, UINT stride) {
    if (g_fvf != 0x144 /*XYZRHW|DIFFUSE|TEX1*/ || stride != 28) return false;
    UINT nv = (pt == 4 && pc == 2) ? 6 : (pt == 5 && pc == 2) ? 4 : 0;
    if (!nv || !g_tex0.ptr || !(g_tex0.usage & 1 /*RENDERTARGET*/) || g_tex0.pool != 0) return false;
    if (g_tex0.fmt != g_rtFmt || g_ps || g_vs || g_fog || g_scissor || g_stencil || g_alphaTest) return false;
    if (g_colorWrite != 0xF || (g_zEnable && !(g_zFunc == 8 && !g_zWrite))) return false;
    if (g_blend && !(g_src == 2 && g_dst == 1 && g_blendOp == 1)) return false;
    if (g_blend && g_sepAlpha && !(g_srcA == 2 && g_dstA == 1)) return false;
    if (g_minFilter != 1 || g_magFilter != 1) return false;
    if (!StageIsTexture(g_tss0[1], g_tss0[2], g_tss0[3]) || !StageIsTexture(g_tss0[4], g_tss0[5], g_tss0[6])) return false;
    if (g_tss1ColorOp != 1 /*DISABLE*/) return false;
    const BYTE* b = (const BYTE*)data;
    float minx = 1e9f, maxx = -1e9f, miny = 1e9f, maxy = -1e9f, kx = 0, ky = 0;
    for (UINT i = 0; i < nv; i++) {
        const float* f = (const float*)(b + i * stride);
        DWORD col = *(const DWORD*)(b + i * stride + 16);
        float u = *(const float*)(b + i * stride + 20), v = *(const float*)(b + i * stride + 24);
        if (col != 0xFFFFFFFF) return false;
        float dx = u * g_tex0.w - f[0], dy = v * g_tex0.h - f[1];
        if (i == 0) { kx = dx; ky = dy; }
        else if (fabsf(dx - kx) > 0.01f || fabsf(dy - ky) > 0.01f) return false;
        if (f[0] < minx) minx = f[0];
        if (f[0] > maxx) maxx = f[0];
        if (f[1] < miny) miny = f[1];
        if (f[1] > maxy) maxy = f[1];
    }
    for (UINT i = 0; i < nv; i++) {  // 軸に平行な長方形の頂点だけでできていること
        const float* f = (const float*)(b + i * stride);
        if ((f[0] != minx && f[0] != maxx) || (f[1] != miny && f[1] != maxy)) return false;
    }
    // D3D9の画素中心は整数座標。中心がminx<=x<maxxの画素が塗られる。
    RECT dr = {(LONG)ceilf(minx), (LONG)ceilf(miny), (LONG)ceilf(maxx), (LONG)ceilf(maxy)};
    LONG ox = (LONG)floorf(kx + 0.001f), oy = (LONG)floorf(ky + 0.001f);
    RECT sr = {dr.left + ox, dr.top + oy, dr.right + ox, dr.bottom + oy};
    if (dr.left < 0 || dr.top < 0 || dr.right > (LONG)g_rtW || dr.bottom > (LONG)g_rtH || dr.right <= dr.left ||
        dr.bottom <= dr.top)
        return false;
    if (sr.left < 0 || sr.top < 0 || sr.right > (LONG)g_tex0.w || sr.bottom > (LONG)g_tex0.h) return false;
    if (g_vpSet && (dr.left < (LONG)g_vp.x || dr.top < (LONG)g_vp.y || dr.right > (LONG)(g_vp.x + g_vp.w) ||
                    dr.bottom > (LONG)(g_vp.y + g_vp.h)))
        return false;
    void* src = nullptr;
    void* dst = nullptr;
    bool ok = false;
    if (SUCCEEDED(((GetSurfaceLevel_t)vt(g_tex0.ptr)[18])(g_tex0.ptr, 0, &src)) && src &&
        SUCCEEDED(((GetRenderTarget_t)vt(dev)[38])(dev, 0, &dst)) && dst && src != dst) {
        ok = SUCCEEDED(o_StretchRect(dev, src, &sr, dst, &dr, 1 /*POINT*/));
        if (ok && g_blitted < 8)
            Log("D3D9Probe: copy->blit src=(%ld,%ld)-(%ld,%ld) dst=(%ld,%ld)-(%ld,%ld) k=(%.3f,%.3f)", sr.left, sr.top,
                sr.right, sr.bottom, dr.left, dr.top, dr.right, dr.bottom, kx, ky);
    }
    if (src) ((Release_t)vt(src)[2])(src);
    if (dst) ((Release_t)vt(dst)[2])(dst);
    if (ok) g_blitted++; else g_blitRejected++;
    return ok;
}

HRESULT WINAPI My_DrawPrimitiveUP(void* dev, DWORD pt, UINT pc, const void* data, UINT stride) {
    if (g_copyToBlit && !g_dumping && TryCopyAsBlit(dev, pt, pc, data, stride)) return S_OK;
    return Draw(2, pt, pc, [&] { return o_DrawPrimitiveUP(dev, pt, pc, data, stride); });
}
HRESULT WINAPI My_DrawIndexedPrimitiveUP(void* dev, DWORD pt, UINT mi, UINT nv, UINT pc, const void* idx, DWORD ifmt, const void* data, UINT stride) {
    return Draw(3, pt, pc, [&] { return o_DrawIndexedPrimitiveUP(dev, pt, mi, nv, pc, idx, ifmt, data, stride); });
}

void OnDeviceCreated(void* dev) {
    if (g_device) { Log("D3D9Probe: second device %p ignored", dev); return; }
    g_device = dev;
    void** v = vt(dev);
    o_CreateQuery = (CreateQuery_t)v[118];
    Patch(v, 17, (void*)My_Present, (void**)&o_Present);
    Patch(v, 23, (void*)My_CreateTexture, (void**)&o_CreateTexture);
    Patch(v, 26, (void*)My_CreateVB, (void**)&o_CreateVB);
    Patch(v, 28, (void*)My_CreateRT, (void**)&o_CreateRT);
    Patch(v, 29, (void*)My_CreateDS, (void**)&o_CreateDS);
    Patch(v, 34, (void*)My_StretchRect, (void**)&o_StretchRect);
    Patch(v, 35, (void*)My_ColorFill, (void**)&o_ColorFill);
    Patch(v, 37, (void*)My_SetRenderTarget, (void**)&o_SetRenderTarget);
    Patch(v, 43, (void*)My_Clear, (void**)&o_Clear);
    Patch(v, 57, (void*)My_SetRenderState, (void**)&o_SetRenderState);
    Patch(v, 65, (void*)My_SetTexture, (void**)&o_SetTexture);
    Patch(v, 69, (void*)My_SetSamplerState, (void**)&o_SetSamplerState);
    Patch(v, 81, (void*)My_DrawPrimitive, (void**)&o_DrawPrimitive);
    Patch(v, 82, (void*)My_DrawIndexedPrimitive, (void**)&o_DrawIndexedPrimitive);
    Patch(v, 83, (void*)My_DrawPrimitiveUP, (void**)&o_DrawPrimitiveUP);
    Patch(v, 84, (void*)My_DrawIndexedPrimitiveUP, (void**)&o_DrawIndexedPrimitiveUP);
    Patch(v, 87, (void*)My_SetVertexDecl, (void**)&o_SetVertexDecl);
    Patch(v, 89, (void*)My_SetFVF, (void**)&o_SetFVF);
    Patch(v, 67, (void*)My_SetTSS, (void**)&o_SetTSS);
    Patch(v, 47, (void*)My_SetViewport, (void**)&o_SetViewport);
    Patch(v, 92, (void*)My_SetVertexShader, (void**)&o_SetVertexShader);
    Patch(v, 107, (void*)My_SetPixelShader, (void**)&o_SetPixelShader);
    void* rt = nullptr;
    if (SUCCEEDED(((GetRenderTarget_t)v[38])(dev, 0, &rt)) && rt) {
        UpdateRT(rt);
        ((Release_t)vt(rt)[2])(rt);
    }
    Log("D3D9Probe: attached to device %p (backbuffer %lux%lu %s), summary=%lu dump_every=%lu", dev, g_rtW,
        g_rtH, FmtName(g_rtFmt), g_summaryFrames, g_dumpEvery);
}

// ---- 実験: D3DXで作るA4R4G4B4テクスチャをA8R8G8B8へ格上げする(D3D9_PROMOTE_A4R4G4B4=1) ----
// th15・th20はテクスチャをD3DXCreateTexture/D3DXCreateTextureFromFileInMemoryExで作り、
// D3DXLoadSurfaceFrom*で書き込む。D3DXは書き込み時に転送先の形式へ変換するので、生成時の
// 形式引数だけを差し替えれば中身はそのまま正しく入る(llvmpipeの描画は8bit RGBAが基本)。
typedef HRESULT(WINAPI* D3DXCreateTexture_t)(void*, UINT, UINT, UINT, DWORD, DWORD, DWORD, void**);
typedef HRESULT(WINAPI* D3DXCreateTexFIMEx_t)(void*, const void*, UINT, UINT, UINT, UINT, DWORD, DWORD, DWORD,
                                               DWORD, DWORD, DWORD, void*, void*, void**);
D3DXCreateTexture_t o_D3DXCreateTexture;
D3DXCreateTexFIMEx_t o_D3DXCreateTexFIMEx;
DWORD Promote(DWORD fmt) {
    if (fmt == 26 /*A4R4G4B4*/) { InterlockedIncrement(&g_promoted); return 21 /*A8R8G8B8*/; }
    return fmt;
}
HRESULT WINAPI My_D3DXCreateTexture(void* dev, UINT w, UINT h, UINT lv, DWORD usage, DWORD fmt, DWORD pool, void** t) {
    return o_D3DXCreateTexture(dev, w, h, lv, usage, Promote(fmt), pool, t);
}
HRESULT WINAPI My_D3DXCreateTexFIMEx(void* dev, const void* src, UINT size, UINT w, UINT h, UINT lv, DWORD usage,
                                      DWORD fmt, DWORD pool, DWORD filt, DWORD mipf, DWORD ck, void* info,
                                      void* pal, void** t) {
    return o_D3DXCreateTexFIMEx(dev, src, size, w, h, lv, usage, Promote(fmt), pool, filt, mipf, ck, info, pal, t);
}

bool HookIAT(const char* dllName, const char* funcName, void* newFunc, void** outOld) {
    BYTE* base = (BYTE*)GetModuleHandle(NULL);
    auto* nt = (IMAGE_NT_HEADERS*)(base + ((IMAGE_DOS_HEADER*)base)->e_lfanew);
    auto& dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (dir.VirtualAddress == 0) return false;
    for (auto* imp = (IMAGE_IMPORT_DESCRIPTOR*)(base + dir.VirtualAddress); imp->Name; imp++) {
        if (_stricmp((char*)(base + imp->Name), dllName) != 0) continue;
        auto* thunk = (IMAGE_THUNK_DATA*)(base + imp->FirstThunk);
        auto* ithunk = (IMAGE_THUNK_DATA*)(base + imp->OriginalFirstThunk);
        for (; thunk->u1.Function; thunk++, ithunk++) {
            if (IMAGE_SNAP_BY_ORDINAL(ithunk->u1.Ordinal)) continue;
            auto* byName = (IMAGE_IMPORT_BY_NAME*)(base + ithunk->u1.AddressOfData);
            if (_stricmp((char*)byName->Name, funcName) != 0) continue;
            DWORD prot;
            VirtualProtect(&thunk->u1.Function, sizeof(void*), PAGE_EXECUTE_READWRITE, &prot);
            *outOld = (void*)thunk->u1.Function;
            thunk->u1.Function = (ULONG_PTR)newFunc;
            VirtualProtect(&thunk->u1.Function, sizeof(void*), prot, &prot);
            return true;
        }
    }
    return false;
}

bool EnvIs1(const char* name) {
    const char* e = getenv(name);
    return e && strcmp(e, "1") == 0;
}

}  // namespace

void InstallD3D9ProbeHook() {
    if (EnvIs1("D3D9_PROMOTE_A4R4G4B4")) {
        bool a = HookIAT("d3dx9_43.dll", "D3DXCreateTexture", (void*)My_D3DXCreateTexture, (void**)&o_D3DXCreateTexture);
        bool b = HookIAT("d3dx9_43.dll", "D3DXCreateTextureFromFileInMemoryEx", (void*)My_D3DXCreateTexFIMEx,
                         (void**)&o_D3DXCreateTexFIMEx);
        Log("InstallD3D9ProbeHook: promote A4R4G4B4->A8R8G8B8 D3DXCreateTexture=%s FromFileInMemoryEx=%s",
            a ? "OK" : "not found", b ? "OK" : "not found");
    }
    g_skipNoop = EnvIs1("D3D9_SKIP_NOOP");
    g_zTrim = EnvIs1("D3D9_ZTRIM");
    g_copyToBlit = EnvIs1("D3D9_COPY_TO_BLIT");
    g_probeLog = EnvIs1("D3D9_PROBE");
    if (!g_probeLog && !g_skipNoop && !g_zTrim && !g_copyToBlit) return;
    if (const char* s = getenv("D3D9_PROBE_SUMMARY_FRAMES")) g_summaryFrames = strtoul(s, nullptr, 10);
    if (const char* s = getenv("D3D9_PROBE_DUMP_EVERY")) g_dumpEvery = strtoul(s, nullptr, 10);
    if (g_summaryFrames == 0) g_summaryFrames = 300;
    if (!g_probeLog) { g_summaryFrames = 3600; g_dumpEvery = 0; }
    g_d3d9DeviceCreatedCallback = OnDeviceCreated;
    Log("InstallD3D9ProbeHook: enabled probe=%d skip_noop=%d ztrim=%d copy_to_blit=%d", g_probeLog, g_skipNoop, g_zTrim, g_copyToBlit);
}

}  // namespace autoplay
