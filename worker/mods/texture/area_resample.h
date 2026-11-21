#pragma once
#include <math.h>
#include <stdint.h>
#include <string.h>
#include <vector>

// D3DXLoadSurfaceFromMemory の縮小フィルタの補完(texture/d3dx_filter.h)の計算部分。
// ホストの g++ でテストできるよう Win32 に依存しない(mods/tests/test_area_resample.cpp)。
// 形式の番号は D3DFORMAT(21=A8R8G8B8 / 22=X8R8G8B8 / 23=R5G6B5 / 24=X1R5G5B5 /
// 25=A1R5G5B5 / 26=A4R4G4B4 / 28=A8 / 30=X4R4G4B4)。

namespace autoplay::area_resample {

// 1画素を ARGB8888 へ展開する。対応外の形式なら false。
inline bool BytesPerPixel(uint32_t fmt, int* bpp) {
    switch (fmt) {
        case 21: case 22: *bpp = 4; return true;
        case 23: case 24: case 25: case 26: case 30: *bpp = 2; return true;
        case 28: *bpp = 1; return true;
        default: return false;
    }
}

inline uint32_t Expand(uint32_t fmt, const uint8_t* p) {
    switch (fmt) {
        case 21: return *(const uint32_t*)p;
        case 22: return *(const uint32_t*)p | 0xFF000000u;
        case 23: {
            uint16_t v = *(const uint16_t*)p;
            uint32_t r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31;
            return 0xFF000000u | ((r * 255 / 31) << 16) | ((g * 255 / 63) << 8) | (b * 255 / 31);
        }
        case 24: case 25: {
            uint16_t v = *(const uint16_t*)p;
            uint32_t a = (fmt == 25) ? ((v & 0x8000) ? 255 : 0) : 255;
            uint32_t r = (v >> 10) & 31, g = (v >> 5) & 31, b = v & 31;
            return (a << 24) | ((r * 255 / 31) << 16) | ((g * 255 / 31) << 8) | (b * 255 / 31);
        }
        case 26: case 30: {
            uint16_t v = *(const uint16_t*)p;
            uint32_t a = (fmt == 26) ? ((v >> 12) & 15) * 17 : 255;
            return (a << 24) | ((((v >> 8) & 15) * 17) << 16) | ((((v >> 4) & 15) * 17) << 8) | ((v & 15) * 17);
        }
        case 28: return (uint32_t)*p << 24;
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
inline constexpr int kWShift = 14;
inline constexpr int kMidShift = 6;  // 横方向の結果の固定小数点の桁(縦方向を 32bit に収めるため)
struct AxisKernel {
    uint32_t nSrc = 0, nDst = 0;
    double rf = -1;
    std::vector<int> start, count, offset;  // 出力 o の重みは w[offset[o] .. offset[o]+count[o])
    std::vector<int> w;
};

inline void BuildKernel(AxisKernel& k, uint32_t nSrc, uint32_t nDst, double radiusFactor) {
    k.nSrc = nSrc; k.nDst = nDst; k.rf = radiusFactor;
    k.start.assign(nDst, 0); k.count.assign(nDst, 0); k.offset.assign(nDst, 0); k.w.clear();
    const double s = (double)nSrc / nDst;
    std::vector<double> tmp;
    for (uint32_t o = 0; o < nDst; o++) {
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

// touhou-recorder では D3DX_AREA_FILTER_RADIUS で変えられたが、本番は検証済みの 0.8 に固定する。
inline constexpr double kRadiusFactor = 0.8;

// 縮小の作業領域(呼び出しをまたいで使い回す)。スレッドセーフではない(呼び出し側で排他する)。
struct Resampler {
    AxisKernel kx, ky;
    std::vector<uint8_t> row_;    // 転送元1行を ARGB(uint32_t のバイト順)に展開したもの
    std::vector<int> runEnd_;     // 同じ値が続く区間の終端
    std::vector<uint32_t> mid_;   // 横方向の縮小結果(Q14、チャンネルごと)
    std::vector<uint8_t> out;    // 転送先の形式に詰めた結果
    std::vector<uint32_t> lut;     // 16bit 形式の展開表
    uint32_t lutFmt = 0;

    void Run(const uint8_t* src, uint32_t pitch, uint32_t fmt, int bpp, uint32_t sw, uint32_t sh,
             uint32_t colorKey, uint32_t dw, uint32_t dh, uint32_t outFmt);
};

// Run: 転送元の矩形 (sw x sh) を転送先 (dw x dh) へ縮小し、outFmt の画素として out に詰める
// (縦横に分離した重み付き平均。各チャンネル独立・非乗算済みアルファで、D3DX の BOX/TRIANGLE と
// 同じ扱い)。outFmt は 26(A4R4G4B4)/30(X4R4G4B4)なら 4bit に四捨五入して 16bit で、それ以外は
// A8R8G8B8 で詰める。4bit への四捨五入を自前で行うのは、Wine の d3dx9 の形式変換が下位を切り捨てる
// うえに遅い(512x20 で 0.25〜0.43ms)ため。全画素が同じ転送元の行は計算を省く。
// 初版(浮動小数点の一時バッファを毎回確保)は 1024x44->512x20 で 1.6〜2.7ms かかり、台詞の
// 切り替わりで 6 回続けて呼ばれるため 1 フレームぶん描画が止まった(reports/101)。
inline void Resampler::Run(const uint8_t* src, uint32_t pitch, uint32_t fmt, int bpp, uint32_t sw, uint32_t sh,
                           uint32_t colorKey, uint32_t dw, uint32_t dh, uint32_t outFmt) {
    const double rf = kRadiusFactor;
    if (kx.nSrc != sw || kx.nDst != dw || kx.rf != rf) BuildKernel(kx, sw, dw, rf);
    if (ky.nSrc != sh || ky.nDst != dh || ky.rf != rf) BuildKernel(ky, sh, dh, rf);
    row_.resize((size_t)sw * 4);
    runEnd_.resize(sw);
    mid_.resize((size_t)dw * sh * 4);
    // 16bit 形式は 65536 要素の展開表を引く(形式が変わったときだけ作り直す)。
    if (bpp == 2 && lutFmt != fmt) {
        lut.resize(65536);
        for (uint32_t v = 0; v < 65536; v++) { uint32_t w = v; lut[v] = Expand(fmt, (const uint8_t*)&w); }  // リトルエンディアンなので下位2バイトが16bit値(4バイト確保は-Warray-boundsの回避)
        lutFmt = fmt;
    }
    // 横方向
    for (uint32_t y = 0; y < sh; y++) {
        const uint8_t* row = src + (size_t)y * pitch;
        uint32_t* mid = &mid_[(size_t)y * dw * 4];
        bool uniform = true;
        if (bpp == 2) {
            const uint16_t* r16 = (const uint16_t*)row;
            for (uint32_t x = 1; x < sw; x++) if (r16[x] != r16[0]) { uniform = false; break; }
        } else if (bpp == 4) {
            const uint32_t* r32 = (const uint32_t*)row;
            for (uint32_t x = 1; x < sw; x++) if (r32[x] != r32[0]) { uniform = false; break; }
        } else {
            for (uint32_t x = 1; x < sw; x++) if (row[x] != row[0]) { uniform = false; break; }
        }
        if (uniform) {
            uint32_t c = Expand(fmt, row);
            if (colorKey && c == colorKey) c = 0;
            uint8_t ch[4];
            memcpy(ch, &c, 4);
            for (uint32_t ox = 0; ox < dw; ox++)
                for (int k = 0; k < 4; k++) mid[ox * 4 + k] = (uint32_t)ch[k] << kMidShift;
            continue;
        }
        uint8_t* rb = row_.data();
        int* runEnd = runEnd_.data();  // runEnd[x] = x から同じ値が続く区間の終端(含まない)
        for (uint32_t x = 0; x < sw; x++) {
            uint32_t c = bpp == 2 ? lut[((const uint16_t*)row)[x]] : Expand(fmt, row + (size_t)x * bpp);
            if (colorKey && c == colorKey) c = 0;  // D3DX: カラーキー一致は透明な黒に置き換える
            memcpy(rb + x * 4, &c, 4);
        }
        runEnd[sw - 1] = sw;
        for (int x = (int)sw - 2; x >= 0; x--)
            runEnd[x] = memcmp(rb + x * 4, rb + (x + 1) * 4, 4) == 0 ? runEnd[x + 1] : x + 1;
        for (uint32_t ox = 0; ox < dw; ox++) {
            const int st = kx.start[ox], cnt = kx.count[ox];
            const uint8_t* p = rb + (size_t)st * 4;
            if (runEnd[st] >= st + cnt) {  // 全タップが同じ値(文字の無い部分)
                for (int k = 0; k < 4; k++) mid[ox * 4 + k] = (uint32_t)p[k] << kMidShift;
                continue;
            }
            const int* w = &kx.w[kx.offset[ox]];
            uint32_t a[4] = {0, 0, 0, 0};
            for (int t = 0; t < cnt; t++, p += 4)
                for (int k = 0; k < 4; k++) a[k] += w[t] * p[k];
            const uint32_t r = 1u << (kWShift - kMidShift - 1);
            for (int k = 0; k < 4; k++) mid[ox * 4 + k] = (a[k] + r) >> (kWShift - kMidShift);
        }
    }
    // 縦方向。横方向の結果は Q6(kMidShift)に落としてあるので、Q6 x Q14 = Q20 は 32bit に収まる
    // (255<<6 に重みの和 1<<14 を掛けても 2.7e8)。
    const bool q4 = outFmt == 26 || outFmt == 30;
    const int obpp = q4 ? 2 : 4;
    out.resize((size_t)dw * dh * obpp);
    const int sh2 = kWShift + kMidShift;
    const uint32_t d4 = 17u << sh2;  // 4bit の 1 段(=8bit で 17)
    for (uint32_t oy = 0; oy < dh; oy++) {
        const int* w = &ky.w[ky.offset[oy]];
        const int n = ky.count[oy], y0 = ky.start[oy];
        for (uint32_t ox = 0; ox < dw; ox++) {
            uint32_t acc[4] = {0, 0, 0, 0};
            for (int t = 0; t < n; t++) {
                const uint32_t* m = &mid_[((size_t)(y0 + t) * dw + ox) * 4];
                for (int k = 0; k < 4; k++) acc[k] += w[t] * m[k];
            }
            uint32_t v[4];
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
                uint16_t px = (uint16_t)((v[3] << 12) | (v[2] << 8) | (v[1] << 4) | v[0]);
                memcpy(&out[((size_t)oy * dw + ox) * 2], &px, 2);
            } else {
                uint32_t px = (v[3] << 24) | (v[2] << 16) | (v[1] << 8) | v[0];
                memcpy(&out[((size_t)oy * dw + ox) * 4], &px, 4);
            }
        }
    }
}


}  // namespace autoplay::area_resample
