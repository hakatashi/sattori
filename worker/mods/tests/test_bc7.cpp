// BC7の展開(texture/bc7_decode.h)。D3D11のBC7仕様から組み立てたブロックで確かめる。
#include "texture/bc7_decode.h"
#include "tests/test.h"

namespace {

// BC7のブロックはLSBから詰めるビット列。
struct BitWriter {
    uint8_t b[16] = {};
    unsigned pos = 0;
    void Put(unsigned v, unsigned n) {
        for (unsigned i = 0; i < n; i++, pos++)
            if ((v >> i) & 1) b[pos >> 3] |= (uint8_t)(1u << (pos & 7));
    }
};

// モード6(1サブセット、RGBA各7bit+端点ごとのPビット、4bitインデックス)のブロック。
// idx[0] はアンカーなので3bit。
BitWriter Mode6(const int ep0[4], const int ep1[4], int p0, int p1, const uint8_t idx[16]) {
    BitWriter w;
    w.Put(1u << 6, 7);  // モード6
    for (int c = 0; c < 4; c++) {
        w.Put(ep0[c], 7);
        w.Put(ep1[c], 7);
    }
    w.Put(p0, 1);
    w.Put(p1, 1);
    for (int i = 0; i < 16; i++) w.Put(idx[i], i == 0 ? 3 : 4);
    return w;
}

int Interp(int a, int b, int w) { return ((64 - w) * a + w * b + 32) >> 6; }

}  // namespace

TEST(Bc7ReservedModeDecodesToZero) {
    uint8_t block[16] = {};  // 先頭8ビットが0 = 予約モード
    uint8_t out[64];
    memset(out, 0xAA, sizeof(out));
    bc7::DecodeBlock(block, out);
    for (int i = 0; i < 64; i++) CHECK_EQ(out[i], (uint8_t)0);
}

TEST(Bc7Mode6Endpoints) {
    const int ep0[4] = {0x40, 0x00, 0x10, 0x7F}, ep1[4] = {0x7F, 0x20, 0x10, 0x00};
    uint8_t idx[16];
    for (int i = 0; i < 16; i++) idx[i] = 15;
    idx[0] = 0;
    idx[5] = 8;
    BitWriter w = Mode6(ep0, ep1, /*p0=*/1, /*p1=*/0, idx);
    uint8_t out[64];
    bc7::DecodeBlock(w.b, out);
    // 端点は (7bit << 1) | Pビット
    const int e0[4] = {0x81, 0x01, 0x21, 0xFF}, e1[4] = {0xFE, 0x40, 0x20, 0x00};
    for (int c = 0; c < 4; c++) {
        CHECK_EQ((int)out[0 * 4 + c], e0[c]);   // インデックス0 = 端点0
        CHECK_EQ((int)out[15 * 4 + c], e1[c]);  // インデックス15(重み64) = 端点1
        CHECK_EQ((int)out[5 * 4 + c], Interp(e0[c], e1[c], 34));  // インデックス8の重みは34
    }
}

TEST(Bc7DecodeImageClipsPartialBlocks) {
    // 6x5 の画像は 2x2 ブロック。はみ出す画素は書かない。
    const int ep[4] = {0x7F, 0x7F, 0x7F, 0x7F};
    uint8_t idx[16] = {};
    BitWriter w = Mode6(ep, ep, 1, 1, idx);
    uint8_t src[4 * 16];
    for (int i = 0; i < 4; i++) memcpy(src + i * 16, w.b, 16);
    const unsigned W = 6, H = 5, pitch = W * 4 + 8;  // 各行の後ろに番兵
    std::vector<uint8_t> dst(pitch * (H + 1), 0x11);
    bc7::DecodeImage(src, 2 * 16, W, H, dst.data(), pitch);
    for (unsigned y = 0; y <= H; y++)
        for (unsigned x = 0; x < pitch; x++) {
            bool inside = y < H && x < W * 4;
            CHECK_EQ((int)dst[y * pitch + x], inside ? 0xFF : 0x11);
        }
}
