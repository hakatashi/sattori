#pragma once
#include <stdint.h>

// 仮想時計の純粋計算(フレーム同期キャプチャ用、Linux/Windows共用)。

namespace autoplay::virtual_clock {

// 1フレーム(1/60秒)あたりの仮想QPC進み幅(ポーリング1回につき 1/60s / stepDiv)。
inline int64_t ComputeStepTicks(int64_t freq, int stepDiv) {
    if (freq <= 0) return 1;
    int d = stepDiv > 0 ? stepDiv : 1;
    int64_t t = freq / 60 / d;
    return t < 1 ? 1 : t;
}

inline int64_t TicksToMs(int64_t ticks, int64_t freq) {
    if (freq <= 0) return 0;
    return ticks * 1000 / freq;
}

inline int64_t MsToTicks(uint64_t ms, int64_t freq) {
    if (freq <= 0 || ms == 0) return 0;
    return (int64_t)(ms * (uint64_t)freq / 1000ULL);
}

// SetWaitableTimer の相対指定(負の100ns単位)を QPCティック数へ換算する。
inline int64_t WaitableDueToTicks(int64_t dueQuadPart, int64_t freq) {
    if (dueQuadPart >= 0 || freq <= 0) return 0;
    return (-dueQuadPart) * freq / 10000000LL;
}

// Present 回数に対応する理想仮想時刻の最小値(1/60秒の整数倍に揃える)。
inline int64_t FrameToMinVirtualTicks(int64_t vtBase, int64_t frame, int64_t freq) {
    if (freq <= 0 || frame <= 0) return vtBase;
    return vtBase + (frame / 60) * freq + ((frame % 60) * freq) / 60;
}

// ミリ秒待ちに対応する Present フレーム数(60fps換算、切り上げ)。
inline int64_t FramesForSleepMs(uint64_t ms) {
    if (ms == 0) return 0;
    return ((int64_t)ms * 60 + 999) / 1000;
}

}  // namespace autoplay::virtual_clock
