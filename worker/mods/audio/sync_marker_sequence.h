#pragma once
#include <stdint.h>

// 同期マーカー(touhou-recorder reports/88)の音の系列。ホストの g++ でテストできるよう
// Win32 に依存しない。
//
// xorshift32(seed=kSeed)の最下位ビットで ±kAmp を選ぶ kSamples サンプル(モノラル換算)。
// **worker/recording/sync_marker.py の marker_sequence() と完全に一致させること**
// (mods/tests/test_sync_marker.cpp と worker/tests/test_mod_log_contract.py が同じゴールデン値で
// 確かめている)。

namespace autoplay::sync_marker {

inline constexpr uint32_t kSamples = 131072;
// -42dBFS。Wineのミキサーで各chへ約-6dB減衰して入る(reports/88)。
inline constexpr int16_t kAmp = 256;
inline constexpr uint32_t kSeed = 0x2545F491u;

struct Sequence {
    uint32_t x = kSeed;
    // 次のサンプル(+kAmp か -kAmp)。
    int Next() {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        return (x & 1) ? kAmp : -kAmp;
    }
};

}  // namespace autoplay::sync_marker
