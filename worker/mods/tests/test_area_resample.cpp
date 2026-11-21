// 文字の縮小フィルタ補完の計算(texture/area_resample.h)。固定小数点・同じ値の連続の省略の結果が、
// 同じ重みを浮動小数点で掛けた素朴な実装と(丸めの範囲で)一致するか。
#include "texture/area_resample.h"
#include "tests/test.h"
#include <cmath>
#include <cstdlib>

using namespace autoplay::area_resample;

namespace {

void CheckKernelSums(uint32_t nSrc, uint32_t nDst, double rf) {
    AxisKernel k;
    BuildKernel(k, nSrc, nDst, rf);
    CHECK_EQ(k.start.size(), (size_t)nDst);
    for (uint32_t o = 0; o < nDst; o++) {
        int sum = 0;
        for (int t = 0; t < k.count[o]; t++) sum += k.w[k.offset[o] + t];
        CHECK_EQ(sum, 1 << kWShift);
        CHECK(k.start[o] >= 0);
        CHECK(k.start[o] + k.count[o] <= (int)nSrc);
    }
}

uint16_t Argb4444(int a, int r, int g, int b) { return (uint16_t)((a << 12) | (r << 8) | (g << 4) | b); }

}  // namespace

TEST(AreaKernelWeightsSumToOne) {
    CheckKernelSums(1024, 512, kRadiusFactor);  // th13 の文字(1024x44 -> 512x20)
    CheckKernelSums(44, 20, kRadiusFactor);
    CheckKernelSums(7, 3, kRadiusFactor);
    CheckKernelSums(7, 3, 0.0);  // 面積平均
    CheckKernelSums(5, 5, kRadiusFactor);
}

TEST(AreaResampleKeepsUniformImage) {
    const uint32_t sw = 64, sh = 22, dw = 32, dh = 10;
    std::vector<uint16_t> src(sw * sh, Argb4444(15, 3, 9, 12));
    Resampler r;
    r.Run((const uint8_t*)src.data(), sw * 2, /*A4R4G4B4*/ 26, 2, sw, sh, 0, dw, dh, /*outFmt*/ 26);
    CHECK_EQ(r.out.size(), (size_t)dw * dh * 2);
    for (uint32_t i = 0; i < dw * dh; i++) {
        uint16_t px;
        memcpy(&px, &r.out[i * 2], 2);
        CHECK_EQ(px, Argb4444(15, 3, 9, 12));
    }
}

TEST(AreaResampleMatchesFloatReference) {
    // 文字に似た 0/F のアルファだけを持つ A4R4G4B4 を、A8R8G8B8 と A4R4G4B4 の両方で縮小する
    const uint32_t sw = 96, sh = 30, dw = 48, dh = 13;
    std::vector<uint16_t> src(sw * sh);
    srand(12345);
    for (auto& px : src) px = Argb4444((rand() & 3) ? 0 : 15, 15, 15, 15);
    for (uint32_t x = 10; x < 40; x++) src[5 * sw + x] = Argb4444(15, 15, 15, 15);  // 横線(同じ値の連続)

    for (uint32_t outFmt : {21u, 26u}) {
        Resampler r;
        r.Run((const uint8_t*)src.data(), sw * 2, 26, 2, sw, sh, 0, dw, dh, outFmt);
        // 同じ重みで、浮動小数点の素朴な分離畳み込み
        AxisKernel kx, ky;
        BuildKernel(kx, sw, dw, kRadiusFactor);
        BuildKernel(ky, sh, dh, kRadiusFactor);
        int maxErr = 0;
        for (uint32_t oy = 0; oy < dh; oy++)
            for (uint32_t ox = 0; ox < dw; ox++)
                for (int ch = 0; ch < 4; ch++) {  // バイト順(B, G, R, A)
                    double acc = 0;
                    for (int ty = 0; ty < ky.count[oy]; ty++)
                        for (int tx = 0; tx < kx.count[ox]; tx++) {
                            uint32_t argb = Expand(26, (const uint8_t*)&src[(ky.start[oy] + ty) * sw + kx.start[ox] + tx]);
                            double v = (argb >> (8 * ch)) & 0xFF;
                            acc += v * kx.w[kx.offset[ox] + tx] * ky.w[ky.offset[oy] + ty] /
                                   (double)(1 << kWShift) / (double)(1 << kWShift);
                        }
                    int got;
                    if (outFmt == 26) {
                        uint16_t px;
                        memcpy(&px, &r.out[(oy * dw + ox) * 2], 2);
                        got = ((px >> (4 * ch)) & 15) * 17;
                    } else {
                        got = r.out[(oy * dw + ox) * 4 + ch];
                    }
                    int err = std::abs(got - (int)std::lround(acc));
                    if (err > maxErr) maxErr = err;
                }
        // A8R8G8B8 は固定小数点の丸めで±1、A4R4G4B4 は4bitへの丸め(1段=17)の半分まで
        CHECK(maxErr <= (outFmt == 26 ? 9 : 1));
    }
}

TEST(AreaResampleTreatsColorKeyAsTransparentBlack) {
    const uint32_t sw = 8, sh = 8, dw = 4, dh = 4;
    std::vector<uint32_t> src(sw * sh, 0xFFFF00FFu);  // 全面がカラーキー
    Resampler r;
    r.Run((const uint8_t*)src.data(), sw * 4, /*A8R8G8B8*/ 21, 4, sw, sh, 0xFFFF00FFu, dw, dh, 21);
    for (uint32_t i = 0; i < dw * dh; i++) {
        uint32_t px;
        memcpy(&px, &r.out[i * 4], 4);
        CHECK_EQ(px, 0u);
    }
}
