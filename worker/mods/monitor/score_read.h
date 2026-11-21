#pragma once
#include <stdint.h>
#include <string.h>

// スコア監視(monitor/score_monitor)が読んだバイト列を値にする部分。ホストの g++ でテストできるよう
// Win32 に依存しない(mods/tests/test_score_read.cpp)。p はリトルエンディアンの width バイト。

namespace autoplay::score_read {

// width(1/2/4/8)バイトの符号なし整数(スコア用)。それ以外の幅なら false。
inline bool DecodeUnsigned(const uint8_t* p, uint8_t width, uint64_t* out) {
    switch (width) {
        case 1: { uint8_t v; memcpy(&v, p, 1); *out = v; return true; }
        case 2: { uint16_t v; memcpy(&v, p, 2); *out = v; return true; }
        case 4: { uint32_t v; memcpy(&v, p, 4); *out = v; return true; }
        case 8: { uint64_t v; memcpy(&v, p, 8); *out = v; return true; }
        default: return false;
    }
}

// width(1/2/4)バイトの符号付き整数、または isFloat なら4バイトの float を0方向へ切り捨てた値
// (ステージ/残機/グレイズ用。th07/th08 の残機は float)。それ以外なら false。
inline bool DecodeSigned(const uint8_t* p, uint8_t width, bool isFloat, int32_t* out) {
    if (width == 0) return false;
    if (isFloat) {
        if (width != 4) return false;
        float v;
        memcpy(&v, p, 4);
        *out = (int32_t)v;
        return true;
    }
    switch (width) {
        case 1: { int8_t v; memcpy(&v, p, 1); *out = v; return true; }
        case 2: { int16_t v; memcpy(&v, p, 2); *out = v; return true; }
        case 4: { int32_t v; memcpy(&v, p, 4); *out = v; return true; }
        default: return false;
    }
}

}  // namespace autoplay::score_read
