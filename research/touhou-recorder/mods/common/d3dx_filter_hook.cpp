#include "d3dx_filter_hook.h"
#include "logging.h"
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <vector>

// 詳細は d3dx_filter_hook.h を参照(reports/101)。

namespace autoplay {

namespace {

typedef HRESULT(WINAPI* LoadFromMemory_t)(void* dstSurf, const PALETTEENTRY* dstPal, const RECT* dstRect,
                                           const void* src, DWORD srcFmt, UINT srcPitch,
                                           const PALETTEENTRY* srcPal, const RECT* srcRect, DWORD filter,
                                           DWORD colorKey);
typedef HRESULT(WINAPI* LoadFromSurface_t)(void* dstSurf, const PALETTEENTRY* dstPal, const RECT* dstRect,
                                            void* srcSurf, const PALETTEENTRY* srcPal, const RECT* srcRect,
                                            DWORD filter, DWORD colorKey);

LoadFromMemory_t o_LoadFromMemory = nullptr;
LoadFromSurface_t o_LoadFromSurface = nullptr;
bool g_probe = false;
bool g_area = false;
volatile LONG g_logs = 0;
volatile LONG g_filtered = 0;
const LONG kMaxLogs = 200;

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

// 1画素を ARGB8888 へ展開する。対応外の形式なら false。
bool BytesPerPixel(DWORD fmt, int* bpp) {
    switch (fmt) {
        case 21: case 22: *bpp = 4; return true;
        case 23: case 24: case 25: case 26: case 30: *bpp = 2; return true;
        case 28: *bpp = 1; return true;
        default: return false;
    }
}

inline DWORD Expand(DWORD fmt, const BYTE* p) {
    switch (fmt) {
        case 21: return *(const DWORD*)p;
        case 22: return *(const DWORD*)p | 0xFF000000u;
        case 23: {
            WORD v = *(const WORD*)p;
            DWORD r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31;
            return 0xFF000000u | ((r * 255 / 31) << 16) | ((g * 255 / 63) << 8) | (b * 255 / 31);
        }
        case 24: case 25: {
            WORD v = *(const WORD*)p;
            DWORD a = (fmt == 25) ? ((v & 0x8000) ? 255 : 0) : 255;
            DWORD r = (v >> 10) & 31, g = (v >> 5) & 31, b = v & 31;
            return (a << 24) | ((r * 255 / 31) << 16) | ((g * 255 / 31) << 8) | (b * 255 / 31);
        }
        case 26: case 30: {
            WORD v = *(const WORD*)p;
            DWORD a = (fmt == 26) ? ((v >> 12) & 15) * 17 : 255;
            return (a << 24) | ((((v >> 8) & 15) * 17) << 16) | ((((v >> 4) & 15) * 17) << 8) | ((v & 15) * 17);
        }
        case 28: return (DWORD)*p << 24;
    }
    return 0;
}

// 1軸ぶんの縮小の重み(Q14 の固定小数点。各出力画素の重みの和はちょうど 1<<14)。
//   radiusFactor > 0: 中心 (o+0.5)*s、半径 radiusFactor*s のテント(三角形)を各転送元画素の
//                     範囲で積分した重み(16点の数値積分)。
//   radiusFactor = 0: 面積平均(出力画素の範囲 [o*s, (o+1)*s) との重なり)。
// th13 の文字の縮小(1024x44->512x20)で、ネイティブ d3dx9_43 の D3DX_FILTER_TRIANGLE の出力と
// 比べると、半径 0.8*s のテントが最も近かった(4bitアルファの完全一致 97.8%、面積平均は 92.7%。
// Windows 実機でも 0.8 が最良。reports/101)。
const int kWShift = 14;
const int kMidShift = 6;  // 横方向の結果の固定小数点の桁(縦方向を 32bit に収めるため)
struct AxisKernel {
    UINT nSrc = 0, nDst = 0;
    double rf = -1;
    std::vector<int> start, count, offset;  // 出力 o の重みは w[offset[o] .. offset[o]+count[o])
    std::vector<int> w;
};

void BuildKernel(AxisKernel& k, UINT nSrc, UINT nDst, double radiusFactor) {
    k.nSrc = nSrc; k.nDst = nDst; k.rf = radiusFactor;
    k.start.assign(nDst, 0); k.count.assign(nDst, 0); k.offset.assign(nDst, 0); k.w.clear();
    const double s = (double)nSrc / nDst;
    std::vector<double> tmp;
    for (UINT o = 0; o < nDst; o++) {
        int i0, i1;
        tmp.clear();
        if (radiusFactor > 0) {
            double ctr = (o + 0.5) * s, r = radiusFactor * s;
            i0 = (int)floor(ctr - r); i1 = (int)ceil(ctr + r);
            if (i0 < 0) i0 = 0;
            if (i1 > (int)nSrc) i1 = nSrc;
            for (int i = i0; i < i1; i++) {
                double acc = 0;
                for (int q = 0; q < 16; q++) {
                    double t = 1.0 - fabs(i + (q + 0.5) / 16.0 - ctr) / r;
                    if (t > 0) acc += t;
                }
                tmp.push_back(acc / 16.0);
            }
        } else {
            double x0 = o * s, x1 = (o + 1) * s;
            i0 = (int)floor(x0); i1 = (int)ceil(x1);
            if (i1 > (int)nSrc) i1 = nSrc;
            for (int i = i0; i < i1; i++) {
                double wv = (i + 1 < x1 ? i + 1 : x1) - (i > x0 ? i : x0);
                tmp.push_back(wv > 0 ? wv : 0);
            }
        }
        double sum = 0;
        for (double v : tmp) sum += v;
        k.start[o] = i0; k.count[o] = (int)tmp.size(); k.offset[o] = (int)k.w.size();
        int isum = 0, imax = 0;
        for (size_t t = 0; t < tmp.size(); t++) {
            int wi = (int)floor((sum > 0 ? tmp[t] / sum : 0) * (1 << kWShift) + 0.5);
            k.w.push_back(wi); isum += wi;
            if (wi > k.w[k.offset[o] + imax]) imax = (int)t;
        }
        if (!tmp.empty()) k.w[k.offset[o] + imax] += (1 << kWShift) - isum;  // 和をちょうど 1<<14 に
    }
}

double RadiusFactor() {
    static double f = -1;
    if (f < 0) {
        const char* e = getenv("D3DX_AREA_FILTER_RADIUS");
        f = e ? atof(e) : 0.8;
        if (f < 0) f = 0;
    }
    return f;
}

// 縮小用の作業領域。転送は描画スレッドから1つずつ呼ばれる想定だが、念のため排他する
// (取れなければ呼び出し側は元の関数へそのまま渡す)。
volatile LONG g_resampleBusy = 0;
AxisKernel g_kx, g_ky;
std::vector<BYTE> g_row;    // 転送元1行を ARGB(DWORD のバイト順)に展開したもの
std::vector<int> g_runEnd;  // 同じ値が続く区間の終端
std::vector<DWORD> g_mid;   // 横方向の縮小結果(Q14、チャンネルごと)
std::vector<BYTE> g_out;    // 転送先の形式に詰めた結果

// 転送元の矩形 (sw x sh) を転送先 (dw x dh) へ縮小し、outFmt の画素として g_out に詰める
// (縦横に分離した重み付き平均。各チャンネル独立・非乗算済みアルファで、D3DX の BOX/TRIANGLE と
// 同じ扱い)。outFmt は 26(A4R4G4B4)/30(X4R4G4B4)なら 4bit に四捨五入して 16bit で、それ以外は
// A8R8G8B8 で詰める。4bit への四捨五入を自前で行うのは、Wine の d3dx9 の形式変換が下位を切り捨てる
// うえに遅い(512x20 で 0.25〜0.43ms)ため。全画素が同じ転送元の行は計算を省く。
// 初版(浮動小数点の一時バッファを毎回確保)は 1024x44->512x20 で 1.6〜2.7ms かかり、台詞の
// 切り替わりで 6 回続けて呼ばれるため 1 フレームぶん描画が止まった(reports/101)。
void AreaResample(const BYTE* src, UINT pitch, DWORD fmt, int bpp, UINT sw, UINT sh, DWORD colorKey,
                  UINT dw, UINT dh, DWORD outFmt) {
    const double rf = RadiusFactor();
    if (g_kx.nSrc != sw || g_kx.nDst != dw || g_kx.rf != rf) BuildKernel(g_kx, sw, dw, rf);
    if (g_ky.nSrc != sh || g_ky.nDst != dh || g_ky.rf != rf) BuildKernel(g_ky, sh, dh, rf);
    g_row.resize((size_t)sw * 4);
    g_runEnd.resize(sw);
    g_mid.resize((size_t)dw * sh * 4);
    // 16bit 形式は 65536 要素の展開表を引く(形式が変わったときだけ作り直す)。
    static std::vector<DWORD> lut;
    static DWORD lutFmt = 0;
    if (bpp == 2 && lutFmt != fmt) {
        lut.resize(65536);
        for (DWORD v = 0; v < 65536; v++) { WORD w16 = (WORD)v; lut[v] = Expand(fmt, (const BYTE*)&w16); }
        lutFmt = fmt;
    }
    // 横方向
    for (UINT y = 0; y < sh; y++) {
        const BYTE* row = src + (size_t)y * pitch;
        DWORD* mid = &g_mid[(size_t)y * dw * 4];
        bool uniform = true;
        if (bpp == 2) {
            const WORD* r16 = (const WORD*)row;
            for (UINT x = 1; x < sw; x++) if (r16[x] != r16[0]) { uniform = false; break; }
        } else if (bpp == 4) {
            const DWORD* r32 = (const DWORD*)row;
            for (UINT x = 1; x < sw; x++) if (r32[x] != r32[0]) { uniform = false; break; }
        } else {
            for (UINT x = 1; x < sw; x++) if (row[x] != row[0]) { uniform = false; break; }
        }
        if (uniform) {
            DWORD c = Expand(fmt, row);
            if (colorKey && c == colorKey) c = 0;
            BYTE ch[4];
            memcpy(ch, &c, 4);
            for (UINT ox = 0; ox < dw; ox++)
                for (int k = 0; k < 4; k++) mid[ox * 4 + k] = (DWORD)ch[k] << kMidShift;
            continue;
        }
        BYTE* rb = g_row.data();
        int* runEnd = g_runEnd.data();  // runEnd[x] = x から同じ値が続く区間の終端(含まない)
        for (UINT x = 0; x < sw; x++) {
            DWORD c = bpp == 2 ? lut[((const WORD*)row)[x]] : Expand(fmt, row + (size_t)x * bpp);
            if (colorKey && c == colorKey) c = 0;  // D3DX: カラーキー一致は透明な黒に置き換える
            memcpy(rb + x * 4, &c, 4);
        }
        runEnd[sw - 1] = sw;
        for (int x = (int)sw - 2; x >= 0; x--)
            runEnd[x] = memcmp(rb + x * 4, rb + (x + 1) * 4, 4) == 0 ? runEnd[x + 1] : x + 1;
        for (UINT ox = 0; ox < dw; ox++) {
            const int st = g_kx.start[ox], cnt = g_kx.count[ox];
            const BYTE* p = rb + (size_t)st * 4;
            if (runEnd[st] >= st + cnt) {  // 全タップが同じ値(文字の無い部分)
                for (int k = 0; k < 4; k++) mid[ox * 4 + k] = (DWORD)p[k] << kMidShift;
                continue;
            }
            const int* w = &g_kx.w[g_kx.offset[ox]];
            DWORD a[4] = {0, 0, 0, 0};
            for (int t = 0; t < cnt; t++, p += 4)
                for (int k = 0; k < 4; k++) a[k] += w[t] * p[k];
            const DWORD r = 1u << (kWShift - kMidShift - 1);
            for (int k = 0; k < 4; k++) mid[ox * 4 + k] = (a[k] + r) >> (kWShift - kMidShift);
        }
    }
    // 縦方向。横方向の結果は Q6(kMidShift)に落としてあるので、Q6 x Q14 = Q20 は 32bit に収まる
    // (255<<6 に重みの和 1<<14 を掛けても 2.7e8)。
    const bool q4 = outFmt == 26 || outFmt == 30;
    const int obpp = q4 ? 2 : 4;
    g_out.resize((size_t)dw * dh * obpp);
    const int sh2 = kWShift + kMidShift;
    const DWORD d4 = 17u << sh2;  // 4bit の 1 段(=8bit で 17)
    for (UINT oy = 0; oy < dh; oy++) {
        const int* w = &g_ky.w[g_ky.offset[oy]];
        const int n = g_ky.count[oy], y0 = g_ky.start[oy];
        for (UINT ox = 0; ox < dw; ox++) {
            DWORD acc[4] = {0, 0, 0, 0};
            for (int t = 0; t < n; t++) {
                const DWORD* m = &g_mid[((size_t)(y0 + t) * dw + ox) * 4];
                for (int k = 0; k < 4; k++) acc[k] += w[t] * m[k];
            }
            DWORD v[4];
            for (int k = 0; k < 4; k++) {
                if (q4) {
                    v[k] = (acc[k] + d4 / 2) / d4;  // round(x/17)
                    if (v[k] > 15) v[k] = 15;
                } else {
                    v[k] = (acc[k] + (1u << (sh2 - 1))) >> sh2;
                    if (v[k] > 255) v[k] = 255;
                }
            }
            // v[] はバイト順(リトルエンディアンの ARGB = B, G, R, A)
            if (q4) {
                WORD px = (WORD)((v[3] << 12) | (v[2] << 8) | (v[1] << 4) | v[0]);
                memcpy(&g_out[((size_t)oy * dw + ox) * 2], &px, 2);
            } else {
                DWORD px = (v[3] << 24) | (v[2] << 16) | (v[1] << 8) | v[0];
                memcpy(&g_out[((size_t)oy * dw + ox) * 4], &px, 4);
            }
        }
    }
}

// D3DX_DUMP_DIR が指定されていれば、拡大縮小を伴う転送(先頭 kMaxDumps 回)について、
// 転送元の矩形と、転送後に LockRect で読み戻した転送先の矩形を
//   <dir>\\d3dx_<n>_src.bin / d3dx_<n>_dst.bin
// に書き出す。形式: DWORD x4 (width, height, D3DFORMAT, bytesPerPixel) + 行を詰めた画素。
// ネイティブ d3dx9(Windows 実機・案B)と D3DX_AREA_FILTER の出力を画素単位で比べるため(reports/101)。
const LONG kMaxDumps = 20;
volatile LONG g_dumps = 0;
typedef HRESULT(WINAPI* LockRect_t)(void*, void* lockedRect, const RECT*, DWORD);
typedef HRESULT(WINAPI* UnlockRect_t)(void*);

void WriteDump(const char* path, UINT w, UINT h, DWORD fmt, int bpp, const BYTE* base, UINT pitch) {
    HANDLE f = CreateFileA(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, 0, NULL);
    if (f == INVALID_HANDLE_VALUE) { Log("D3DXFilterHook: dump open failed %s", path); return; }
    DWORD hdr[4] = {w, h, fmt, (DWORD)bpp}, wr;
    WriteFile(f, hdr, sizeof(hdr), &wr, NULL);
    for (UINT y = 0; y < h; y++) WriteFile(f, base + (size_t)y * pitch, w * bpp, &wr, NULL);
    CloseHandle(f);
}

void DumpTransfer(const void* src, DWORD srcFmt, UINT srcPitch, const RECT& sr, void* dstSurf, const RECT& dr,
                  DWORD dstFmt) {
    const char* dir = getenv("D3DX_DUMP_DIR");
    if (!dir) return;
    LONG n = InterlockedIncrement(&g_dumps);
    if (n > kMaxDumps) return;
    int sbpp = 0, dbpp = 0;
    if (!BytesPerPixel(srcFmt, &sbpp) || !BytesPerPixel(dstFmt, &dbpp)) return;
    char path[MAX_PATH];
    wsprintfA(path, "%s\\d3dx_%02ld_src.bin", dir, n);
    WriteDump(path, sr.right - sr.left, sr.bottom - sr.top, srcFmt, sbpp,
              (const BYTE*)src + (size_t)sr.top * srcPitch + (size_t)sr.left * sbpp, srcPitch);
    struct { INT Pitch; void* pBits; } lr = {0, nullptr};
    void** vt = *(void***)dstSurf;
    HRESULT hr = ((LockRect_t)vt[13])(dstSurf, &lr, &dr, 0x10 /*D3DLOCK_READONLY*/);
    if (FAILED(hr)) { Log("D3DXFilterHook: dump LockRect failed hr=%#lx", (unsigned long)hr); return; }
    wsprintfA(path, "%s\\d3dx_%02ld_dst.bin", dir, n);
    WriteDump(path, dr.right - dr.left, dr.bottom - dr.top, dstFmt, dbpp, (const BYTE*)lr.pBits, lr.Pitch);
    ((UnlockRect_t)vt[14])(dstSurf);
    Log("D3DXFilterHook: dumped transfer %ld (%ldx%ld -> %ldx%ld)", n, sr.right - sr.left, sr.bottom - sr.top,
        dr.right - dr.left, dr.bottom - dr.top);
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
    if (g_probe && InterlockedIncrement(&g_logs) <= kMaxLogs) {
        Log("D3DXLoadSurfaceFromMemory: dst=%ux%u/%s rect=(%ld,%ld)-(%ld,%ld) src=%s pitch=%u rect=(%ld,%ld)-(%ld,%ld) filter=%#lx colorkey=%#lx",
            tw, th, FmtName(tfmt), dr.left, dr.top, dr.right, dr.bottom, FmtName(srcFmt), srcPitch, sr.left, sr.top,
            sr.right, sr.bottom, filter, colorKey);
    }
    int bpp = 0;
    bool scaled = srcRect && (sw != dw || sh != dh);
    bool mirror = filter != 0xFFFFFFFFu && (filter & 0x70000);
    if (g_area && scaled && sw >= dw && sh >= dh && dw > 0 && dh > 0 && ftype >= 3 && ftype <= 5 && !mirror &&
        !srcPal && BytesPerPixel(srcFmt, &bpp)) {
        if (InterlockedExchange(&g_resampleBusy, 1))  // 別スレッドが使用中なら元の関数へ
            return o_LoadFromMemory(dstSurf, dstPal, dstRect, src, srcFmt, srcPitch, srcPal, srcRect, filter,
                                    colorKey);
        LARGE_INTEGER q0, q1, q2, qf;
        QueryPerformanceCounter(&q0);
        // 転送先が 4bit 形式ならその形式で、それ以外は A8R8G8B8 で作り、同じサイズ・FILTER_NONE で渡す。
        const DWORD outFmt = (tfmt == 26 || tfmt == 30) ? tfmt : 21;
        const BYTE* base = (const BYTE*)src + (size_t)sr.top * srcPitch + (size_t)sr.left * bpp;
        AreaResample(base, srcPitch, srcFmt, bpp, sw, sh, colorKey, dw, dh, outFmt);
        RECT nr = {0, 0, (LONG)dw, (LONG)dh};
        QueryPerformanceCounter(&q1);
        HRESULT hr = o_LoadFromMemory(dstSurf, dstPal, dstRect, g_out.data(), outFmt, dw * (outFmt == 21 ? 4 : 2),
                                      nullptr, &nr, 1 /*D3DX_FILTER_NONE*/, 0);
        QueryPerformanceCounter(&q2);
        InterlockedExchange(&g_resampleBusy, 0);
        LONG n = InterlockedIncrement(&g_filtered);
        static const bool splitLog = getenv("D3DX_TIMING") != nullptr;
        if (splitLog && n <= 60) {
            QueryPerformanceFrequency(&qf);
            Log("D3DXFilterHook: split #%ld %ux%u->%ux%u resample=%.3fms d3dx(NONE, %s->%s)=%.3fms", n, sw, sh,
                dw, dh, (q1.QuadPart - q0.QuadPart) * 1000.0 / qf.QuadPart, FmtName(outFmt), FmtName(tfmt),
                (q2.QuadPart - q1.QuadPart) * 1000.0 / qf.QuadPart);
        }
        if (n <= 5 || (n % 500) == 0)
            Log("D3DXFilterHook: area-filtered %ux%u -> %ux%u (%s, filter=%#lx, radius=%.2f) hr=%#lx count=%ld", sw, sh,
                dw, dh, FmtName(srcFmt), filter, RadiusFactor(), (unsigned long)hr, n);
        if (SUCCEEDED(hr)) DumpTransfer(src, srcFmt, srcPitch, sr, dstSurf, dr, tfmt);
        return hr;
    }
    LARGE_INTEGER q0, q1, qf;
    QueryPerformanceCounter(&q0);
    HRESULT hr = o_LoadFromMemory(dstSurf, dstPal, dstRect, src, srcFmt, srcPitch, srcPal, srcRect, filter, colorKey);
    QueryPerformanceCounter(&q1);
    static const bool splitLog = getenv("D3DX_TIMING") != nullptr;
    static volatile LONG scaledLogs = 0;
    // 案Aを使わない場合(現行の内蔵 d3dx9・ネイティブ d3dx9)の、拡大縮小を伴う転送1回の時間。
    if (splitLog && scaled && InterlockedIncrement(&scaledLogs) <= 60) {
        QueryPerformanceFrequency(&qf);
        Log("D3DXFilterHook: scaled-call %ux%u->%ux%u (%s, filter=%#lx) d3dx=%.3fms", sw, sh, dw, dh, FmtName(srcFmt),
            filter, (q1.QuadPart - q0.QuadPart) * 1000.0 / qf.QuadPart);
    }
    if (SUCCEEDED(hr) && scaled && !srcPal) DumpTransfer(src, srcFmt, srcPitch, sr, dstSurf, dr, tfmt);
    return hr;
}

HRESULT WINAPI My_LoadFromSurface(void* dstSurf, const PALETTEENTRY* dstPal, const RECT* dstRect, void* srcSurf,
                                  const PALETTEENTRY* srcPal, const RECT* srcRect, DWORD filter, DWORD colorKey) {
    if (g_probe && InterlockedIncrement(&g_logs) <= kMaxLogs) {
        UINT tw = 0, th = 0, sw = 0, sh = 0;
        DWORD tf = 0, sf = 0;
        GetSurfaceSize(dstSurf, &tw, &th, &tf);
        GetSurfaceSize(srcSurf, &sw, &sh, &sf);
        RECT dr = dstRect ? *dstRect : RECT{0, 0, (LONG)tw, (LONG)th};
        RECT sr = srcRect ? *srcRect : RECT{0, 0, (LONG)sw, (LONG)sh};
        Log("D3DXLoadSurfaceFromSurface: dst=%ux%u/%s rect=(%ld,%ld)-(%ld,%ld) src=%ux%u/%s rect=(%ld,%ld)-(%ld,%ld) filter=%#lx colorkey=%#lx",
            tw, th, FmtName(tf), dr.left, dr.top, dr.right, dr.bottom, sw, sh, FmtName(sf), sr.left, sr.top,
            sr.right, sr.bottom, filter, colorKey);
    }
    return o_LoadFromSurface(dstSurf, dstPal, dstRect, srcSurf, srcPal, srcRect, filter, colorKey);
}

// dllPrefix で始まる名前の DLL(th10 は d3dx9_31.dll、th13 は d3dx9_43.dll のように
// タイトルごとにバージョンが違う)の import を差し替える。
bool HookIAT(const char* dllPrefix, const char* funcName, void* newFunc, void** outOld) {
    BYTE* base = (BYTE*)GetModuleHandle(NULL);
    auto* nt = (IMAGE_NT_HEADERS*)(base + ((IMAGE_DOS_HEADER*)base)->e_lfanew);
    auto& dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (dir.VirtualAddress == 0) return false;
    for (auto* imp = (IMAGE_IMPORT_DESCRIPTOR*)(base + dir.VirtualAddress); imp->Name; imp++) {
        if (_strnicmp((char*)(base + imp->Name), dllPrefix, strlen(dllPrefix)) != 0) continue;
        auto* thunk = (IMAGE_THUNK_DATA*)(base + imp->FirstThunk);
        auto* ithunk = (IMAGE_THUNK_DATA*)(base + imp->OriginalFirstThunk);
        for (; thunk->u1.Function; thunk++, ithunk++) {
            if (IMAGE_SNAP_BY_ORDINAL(ithunk->u1.Ordinal)) continue;
            auto* byName = (IMAGE_IMPORT_BY_NAME*)(base + ithunk->u1.AddressOfData);
            if (_stricmp((char*)byName->Name, funcName) != 0) continue;
            DWORD prot;
            VirtualProtect(&thunk->u1.Function, sizeof(void*), PAGE_EXECUTE_READWRITE, &prot);
            Log("InstallD3DXFilterHook: hooked %s!%s", (char*)(base + imp->Name), funcName);
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


// ---- 計時(D3DX_TIMING=1、reports/101) ----
// th13 が import する d3dx9 の関数すべてを包み、関数ごとの呼び出し回数・合計時間・最大時間を
// 10 秒ごとに累計でログに出す。案A(MOD 側の縮小)と案B(ネイティブ d3dx9)の負荷を比べるため。
// 引数はすべて 4 バイト(ポインタ・UINT・FLOAT)の stdcall で、戻り値はポインタか HRESULT
// なので、引数の数だけ合わせた DWORD の汎用ラッパーで中身をそのまま渡せる(FLOAT もスタック上は
// 4 バイトのビット列)。他のフック(縮小・記録)を入れた後に包むので、その時間も含む。
struct TimingStat {
    const char* name;
    int nargs;
    void* orig;
    volatile LONG count;
    LONGLONG ticks;
    LONGLONG maxTicks;
};
LARGE_INTEGER g_qpf = {};
LONGLONG g_lastSummary = 0;
volatile LONG g_summaryLock = 0;

TimingStat g_ts[17] = {
    {"D3DXCreateTexture", 8, nullptr, 0, 0, 0},
    {"D3DXCreateTextureFromFileInMemoryEx", 15, nullptr, 0, 0, 0},
    {"D3DXLoadSurfaceFromFileInMemory", 9, nullptr, 0, 0, 0},
    {"D3DXLoadSurfaceFromMemory", 10, nullptr, 0, 0, 0},
    {"D3DXLoadSurfaceFromSurface", 8, nullptr, 0, 0, 0},
    {"D3DXMatrixLookAtLH", 4, nullptr, 0, 0, 0},
    {"D3DXMatrixMultiply", 3, nullptr, 0, 0, 0},
    {"D3DXMatrixPerspectiveFovLH", 5, nullptr, 0, 0, 0},
    {"D3DXMatrixRotationX", 2, nullptr, 0, 0, 0},
    {"D3DXMatrixRotationY", 2, nullptr, 0, 0, 0},
    {"D3DXMatrixRotationZ", 2, nullptr, 0, 0, 0},
    {"D3DXMatrixTranslation", 4, nullptr, 0, 0, 0},
    {"D3DXVec2Normalize", 2, nullptr, 0, 0, 0},
    {"D3DXVec3Normalize", 2, nullptr, 0, 0, 0},
    {"D3DXVec3Project", 6, nullptr, 0, 0, 0},
    {"D3DXVec3ProjectArray", 9, nullptr, 0, 0, 0},
    {"D3DXVec3Transform", 3, nullptr, 0, 0, 0}
};

void TimingSummaryMaybe(LONGLONG now) {
    if (now - g_lastSummary < g_qpf.QuadPart * 10) return;
    if (InterlockedExchange(&g_summaryLock, 1)) return;
    g_lastSummary = now;
    for (auto& s : g_ts) {
        if (!s.count) continue;
        Log("D3DXTiming: %-36s calls=%8ld total=%9.3fms avg=%8.3fus max=%9.3fus", s.name, s.count,
            s.ticks * 1000.0 / g_qpf.QuadPart, s.ticks * 1e6 / g_qpf.QuadPart / s.count,
            s.maxTicks * 1e6 / g_qpf.QuadPart);
    }
    InterlockedExchange(&g_summaryLock, 0);
}

inline void TimingRecord(TimingStat& s, LONGLONG t0) {
    LARGE_INTEGER t1;
    QueryPerformanceCounter(&t1);
    LONGLONG d = t1.QuadPart - t0;
    InterlockedIncrement(&s.count);
    s.ticks += d;
    if (d > s.maxTicks) s.maxTicks = d;
    TimingSummaryMaybe(t1.QuadPart);
}

DWORD WINAPI T_D3DXCreateTexture(DWORD a0, DWORD a1, DWORD a2, DWORD a3, DWORD a4, DWORD a5, DWORD a6, DWORD a7) {
    LARGE_INTEGER t0; QueryPerformanceCounter(&t0);
    DWORD r = ((DWORD(WINAPI*)(DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD))g_ts[0].orig)(a0, a1, a2, a3, a4, a5, a6, a7);
    TimingRecord(g_ts[0], t0.QuadPart);
    return r;
}
DWORD WINAPI T_D3DXCreateTextureFromFileInMemoryEx(DWORD a0, DWORD a1, DWORD a2, DWORD a3, DWORD a4, DWORD a5, DWORD a6, DWORD a7, DWORD a8, DWORD a9, DWORD a10, DWORD a11, DWORD a12, DWORD a13, DWORD a14) {
    LARGE_INTEGER t0; QueryPerformanceCounter(&t0);
    DWORD r = ((DWORD(WINAPI*)(DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD))g_ts[1].orig)(a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14);
    TimingRecord(g_ts[1], t0.QuadPart);
    return r;
}
DWORD WINAPI T_D3DXLoadSurfaceFromFileInMemory(DWORD a0, DWORD a1, DWORD a2, DWORD a3, DWORD a4, DWORD a5, DWORD a6, DWORD a7, DWORD a8) {
    LARGE_INTEGER t0; QueryPerformanceCounter(&t0);
    DWORD r = ((DWORD(WINAPI*)(DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD))g_ts[2].orig)(a0, a1, a2, a3, a4, a5, a6, a7, a8);
    TimingRecord(g_ts[2], t0.QuadPart);
    return r;
}
DWORD WINAPI T_D3DXLoadSurfaceFromMemory(DWORD a0, DWORD a1, DWORD a2, DWORD a3, DWORD a4, DWORD a5, DWORD a6, DWORD a7, DWORD a8, DWORD a9) {
    LARGE_INTEGER t0; QueryPerformanceCounter(&t0);
    DWORD r = ((DWORD(WINAPI*)(DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD))g_ts[3].orig)(a0, a1, a2, a3, a4, a5, a6, a7, a8, a9);
    TimingRecord(g_ts[3], t0.QuadPart);
    return r;
}
DWORD WINAPI T_D3DXLoadSurfaceFromSurface(DWORD a0, DWORD a1, DWORD a2, DWORD a3, DWORD a4, DWORD a5, DWORD a6, DWORD a7) {
    LARGE_INTEGER t0; QueryPerformanceCounter(&t0);
    DWORD r = ((DWORD(WINAPI*)(DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD))g_ts[4].orig)(a0, a1, a2, a3, a4, a5, a6, a7);
    TimingRecord(g_ts[4], t0.QuadPart);
    return r;
}
DWORD WINAPI T_D3DXMatrixLookAtLH(DWORD a0, DWORD a1, DWORD a2, DWORD a3) {
    LARGE_INTEGER t0; QueryPerformanceCounter(&t0);
    DWORD r = ((DWORD(WINAPI*)(DWORD, DWORD, DWORD, DWORD))g_ts[5].orig)(a0, a1, a2, a3);
    TimingRecord(g_ts[5], t0.QuadPart);
    return r;
}
DWORD WINAPI T_D3DXMatrixMultiply(DWORD a0, DWORD a1, DWORD a2) {
    LARGE_INTEGER t0; QueryPerformanceCounter(&t0);
    DWORD r = ((DWORD(WINAPI*)(DWORD, DWORD, DWORD))g_ts[6].orig)(a0, a1, a2);
    TimingRecord(g_ts[6], t0.QuadPart);
    return r;
}
DWORD WINAPI T_D3DXMatrixPerspectiveFovLH(DWORD a0, DWORD a1, DWORD a2, DWORD a3, DWORD a4) {
    LARGE_INTEGER t0; QueryPerformanceCounter(&t0);
    DWORD r = ((DWORD(WINAPI*)(DWORD, DWORD, DWORD, DWORD, DWORD))g_ts[7].orig)(a0, a1, a2, a3, a4);
    TimingRecord(g_ts[7], t0.QuadPart);
    return r;
}
DWORD WINAPI T_D3DXMatrixRotationX(DWORD a0, DWORD a1) {
    LARGE_INTEGER t0; QueryPerformanceCounter(&t0);
    DWORD r = ((DWORD(WINAPI*)(DWORD, DWORD))g_ts[8].orig)(a0, a1);
    TimingRecord(g_ts[8], t0.QuadPart);
    return r;
}
DWORD WINAPI T_D3DXMatrixRotationY(DWORD a0, DWORD a1) {
    LARGE_INTEGER t0; QueryPerformanceCounter(&t0);
    DWORD r = ((DWORD(WINAPI*)(DWORD, DWORD))g_ts[9].orig)(a0, a1);
    TimingRecord(g_ts[9], t0.QuadPart);
    return r;
}
DWORD WINAPI T_D3DXMatrixRotationZ(DWORD a0, DWORD a1) {
    LARGE_INTEGER t0; QueryPerformanceCounter(&t0);
    DWORD r = ((DWORD(WINAPI*)(DWORD, DWORD))g_ts[10].orig)(a0, a1);
    TimingRecord(g_ts[10], t0.QuadPart);
    return r;
}
DWORD WINAPI T_D3DXMatrixTranslation(DWORD a0, DWORD a1, DWORD a2, DWORD a3) {
    LARGE_INTEGER t0; QueryPerformanceCounter(&t0);
    DWORD r = ((DWORD(WINAPI*)(DWORD, DWORD, DWORD, DWORD))g_ts[11].orig)(a0, a1, a2, a3);
    TimingRecord(g_ts[11], t0.QuadPart);
    return r;
}
DWORD WINAPI T_D3DXVec2Normalize(DWORD a0, DWORD a1) {
    LARGE_INTEGER t0; QueryPerformanceCounter(&t0);
    DWORD r = ((DWORD(WINAPI*)(DWORD, DWORD))g_ts[12].orig)(a0, a1);
    TimingRecord(g_ts[12], t0.QuadPart);
    return r;
}
DWORD WINAPI T_D3DXVec3Normalize(DWORD a0, DWORD a1) {
    LARGE_INTEGER t0; QueryPerformanceCounter(&t0);
    DWORD r = ((DWORD(WINAPI*)(DWORD, DWORD))g_ts[13].orig)(a0, a1);
    TimingRecord(g_ts[13], t0.QuadPart);
    return r;
}
DWORD WINAPI T_D3DXVec3Project(DWORD a0, DWORD a1, DWORD a2, DWORD a3, DWORD a4, DWORD a5) {
    LARGE_INTEGER t0; QueryPerformanceCounter(&t0);
    DWORD r = ((DWORD(WINAPI*)(DWORD, DWORD, DWORD, DWORD, DWORD, DWORD))g_ts[14].orig)(a0, a1, a2, a3, a4, a5);
    TimingRecord(g_ts[14], t0.QuadPart);
    return r;
}
DWORD WINAPI T_D3DXVec3ProjectArray(DWORD a0, DWORD a1, DWORD a2, DWORD a3, DWORD a4, DWORD a5, DWORD a6, DWORD a7, DWORD a8) {
    LARGE_INTEGER t0; QueryPerformanceCounter(&t0);
    DWORD r = ((DWORD(WINAPI*)(DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD))g_ts[15].orig)(a0, a1, a2, a3, a4, a5, a6, a7, a8);
    TimingRecord(g_ts[15], t0.QuadPart);
    return r;
}
DWORD WINAPI T_D3DXVec3Transform(DWORD a0, DWORD a1, DWORD a2) {
    LARGE_INTEGER t0; QueryPerformanceCounter(&t0);
    DWORD r = ((DWORD(WINAPI*)(DWORD, DWORD, DWORD))g_ts[16].orig)(a0, a1, a2);
    TimingRecord(g_ts[16], t0.QuadPart);
    return r;
}
void* g_tsWrappers[] = {(void*)T_D3DXCreateTexture, (void*)T_D3DXCreateTextureFromFileInMemoryEx, (void*)T_D3DXLoadSurfaceFromFileInMemory, (void*)T_D3DXLoadSurfaceFromMemory, (void*)T_D3DXLoadSurfaceFromSurface, (void*)T_D3DXMatrixLookAtLH, (void*)T_D3DXMatrixMultiply, (void*)T_D3DXMatrixPerspectiveFovLH, (void*)T_D3DXMatrixRotationX, (void*)T_D3DXMatrixRotationY, (void*)T_D3DXMatrixRotationZ, (void*)T_D3DXMatrixTranslation, (void*)T_D3DXVec2Normalize, (void*)T_D3DXVec3Normalize, (void*)T_D3DXVec3Project, (void*)T_D3DXVec3ProjectArray, (void*)T_D3DXVec3Transform};

}  // namespace

int InstallD3DXFilterHook() {
    g_probe = EnvIs1("D3DX_LOAD_PROBE");
    g_area = EnvIs1("D3DX_AREA_FILTER");
    bool timing = EnvIs1("D3DX_TIMING");
    if (!g_probe && !g_area && !getenv("D3DX_DUMP_DIR") && !timing) return 0;
    int n = 0;
    if (HookIAT("d3dx9_", "D3DXLoadSurfaceFromMemory", (void*)My_LoadFromMemory, (void**)&o_LoadFromMemory)) n++;
    if (HookIAT("d3dx9_", "D3DXLoadSurfaceFromSurface", (void*)My_LoadFromSurface, (void**)&o_LoadFromSurface))
        n++;
    if (timing) {
        // 縮小・記録のフックより外側に被せる(HookIAT は今の IAT の値を orig として返す)。
        QueryPerformanceFrequency(&g_qpf);
        int t = 0;
        for (size_t i = 0; i < sizeof(g_ts) / sizeof(g_ts[0]); i++)
            if (HookIAT("d3dx9_", g_ts[i].name, g_tsWrappers[i], &g_ts[i].orig)) t++;
        Log("InstallD3DXFilterHook: timing hooked %d/%u", t, (unsigned)(sizeof(g_ts) / sizeof(g_ts[0])));
    }
    Log("InstallD3DXFilterHook: probe=%d area_filter=%d hooked=%d", g_probe, g_area, n);
    return n;
}

}  // namespace autoplay
