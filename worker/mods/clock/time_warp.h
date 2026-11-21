#pragma once
#include <stdint.h>

// 時刻の写像(基準時刻からの経過を scale 倍に伸縮する)。clock/speed_hack(倍速録画)と
// clock/fps_display(fps表示の補正)が使う。ホストの g++ でテストできるよう Win32 に依存しない。

namespace autoplay::time_warp {

// QueryPerformanceCounter のカウンタ値(64bit)。
inline int64_t Counter(int64_t base, int64_t now, double scale) {
    int64_t elapsed = now - base;
    return base + (int64_t)((double)elapsed * scale);
}

// timeGetTime のミリ秒値(32bit、約49.7日で一周する)。差は符号なしで取るので、一周をまたいでも
// 経過時間は正しい。
inline uint32_t Millis(uint32_t base, uint32_t now, double scale) {
    return base + (uint32_t)((double)(uint32_t)(now - base) * scale);
}

}  // namespace autoplay::time_warp
