#pragma once
#include <math.h>
#include <stdint.h>

// 仮想音声ミキサの純粋計算(音量/パン/s16変換/通知境界、Linux/Windows共用)。

namespace autoplay::audio::virtual_mix {

inline float DbHundredthsToGain(long dbHundredths) {
    long v = dbHundredths < -10000 ? -10000 : (dbHundredths > 0 ? 0 : dbHundredths);
    return (float)pow(10.0, (double)v / 2000.0);
}

inline void PanHundredthsToGains(long volumeHundredths, long panHundredths, float* gainL,
                                 float* gainR) {
    float vol = DbHundredthsToGain(volumeHundredths);
    long p = panHundredths < -10000 ? -10000 : (panHundredths > 10000 ? 10000 : panHundredths);
    float l = vol;
    float r = vol;
    if (p > 0) l *= (float)pow(10.0, -(double)p / 2000.0);
    if (p < 0) r *= (float)pow(10.0, (double)p / 2000.0);
    *gainL = l;
    *gainR = r;
}

inline short FloatToS16Clamp(float sample) {
    float v = sample * 32767.0f;
    if (v > 32767.0f) return 32767;
    if (v < -32768.0f) return -32768;
    return (short)lrintf(v);
}

inline bool CrossedNotifyOffset(uint32_t offset, uint32_t prev, uint32_t cur, bool wrapped) {
    return wrapped ? (offset > prev || offset <= cur) : (offset > prev && offset <= cur);
}

}  // namespace autoplay::audio::virtual_mix
