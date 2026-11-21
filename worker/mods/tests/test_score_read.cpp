// スコア監視の値の読み取り(monitor/score_read.h)。タイトルごとに幅・符号・float が違う
// (th06の残機は1バイト、th07/th08の残機はfloat、th20のスコアは64bit)。
#include "monitor/score_read.h"
#include "tests/test.h"

using namespace autoplay::score_read;

TEST(DecodeUnsignedByWidth) {
    const uint8_t b[8] = {0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11};
    uint64_t v = 0;
    CHECK(DecodeUnsigned(b, 1, &v)); CHECK_EQ(v, (uint64_t)0x88);
    CHECK(DecodeUnsigned(b, 2, &v)); CHECK_EQ(v, (uint64_t)0x7788);
    CHECK(DecodeUnsigned(b, 4, &v)); CHECK_EQ(v, (uint64_t)0x55667788);
    CHECK(DecodeUnsigned(b, 8, &v)); CHECK_EQ(v, (uint64_t)0x1122334455667788ULL);
    v = 42;
    CHECK(!DecodeUnsigned(b, 0, &v));
    CHECK(!DecodeUnsigned(b, 3, &v));
    CHECK_EQ(v, (uint64_t)42);  // 失敗したら書き換えない
}

TEST(DecodeSignedByWidth) {
    const uint8_t neg[4] = {0xFE, 0xFF, 0xFF, 0xFF};
    int32_t v = 0;
    CHECK(DecodeSigned(neg, 1, false, &v)); CHECK_EQ(v, -2);
    CHECK(DecodeSigned(neg, 2, false, &v)); CHECK_EQ(v, -2);
    CHECK(DecodeSigned(neg, 4, false, &v)); CHECK_EQ(v, -2);
    const uint8_t pos[4] = {0x39, 0x30, 0x00, 0x00};
    CHECK(DecodeSigned(pos, 4, false, &v)); CHECK_EQ(v, 12345);
    v = 7;
    CHECK(!DecodeSigned(pos, 0, false, &v));
    CHECK(!DecodeSigned(pos, 8, false, &v));
    CHECK_EQ(v, 7);
}

TEST(DecodeSignedFloatTruncatesTowardZero) {
    uint8_t b[4];
    float f = 2.75f;  // th07/th08 の残機(破片で端数が付く)
    memcpy(b, &f, 4);
    int32_t v = 0;
    CHECK(DecodeSigned(b, 4, true, &v)); CHECK_EQ(v, 2);
    f = -0.5f;
    memcpy(b, &f, 4);
    CHECK(DecodeSigned(b, 4, true, &v)); CHECK_EQ(v, 0);
    CHECK(!DecodeSigned(b, 2, true, &v));  // float は4バイトだけ
}
