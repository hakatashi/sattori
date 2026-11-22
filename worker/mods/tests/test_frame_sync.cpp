// フレーム同期キャプチャの純粋ロジックの単体テスト(Linux ホスト g++ 用)。
#include "audio/virtual/mix_math.h"
#include "clock/virtual_clock_math.h"
#include "core/runtime_config.h"
#include "present/capture/pixel_format.h"
#include "tests/test.h"
#include <cmath>
#include <map>
#include <string>

using namespace autoplay;

namespace {

RuntimeConfig ParseMap(std::map<std::string, std::string> env) {
    return ParseRuntimeConfig([&](const char* name) -> const char* {
        auto it = env.find(name);
        return it == env.end() ? nullptr : it->second.c_str();
    });
}

bool Near(float a, float b, float eps = 1e-4f) { return std::fabs(a - b) < eps; }

}  // namespace

TEST(RuntimeConfigFrameSyncDefaultsAndParsing) {
    RuntimeConfig d = ParseMap({});
    CHECK(!d.FrameSyncEnabled());
    CHECK_EQ(d.frameSyncStepDiv, 0);
    CHECK_EQ(d.FrameSyncStepDivOr(64), 64);
    CHECK(!d.frameSyncSkipPresent);
    CHECK(d.frameSyncPipeline);
    CHECK(!d.frameSyncThrottleWhileThreads);
    CHECK_EQ(d.frameSyncThreadMaxMs, 10000UL);
    CHECK_EQ(d.frameSyncAudioRefillWaitMs, 500UL);

    RuntimeConfig c = ParseMap({{"FRAME_SYNC_PIPE", "Z:\\tmp\\video.yuv"},
                                {"FRAME_SYNC_STOP", "Z:\\tmp\\stop"},
                                {"FRAME_SYNC_AUDIO", "Z:\\tmp\\audio.pcm"},
                                {"FRAME_SYNC_STEP_DIV", "32"},
                                {"FRAME_SYNC_SKIP_PRESENT", "1"},
                                {"FRAME_SYNC_PIPELINE", "0"},
                                {"FRAME_SYNC_THROTTLE_WHILE_THREADS", "1"},
                                {"FRAME_SYNC_THREAD_MAX_MS", "2500"},
                                {"FRAME_SYNC_AUDIO_REFILL_WAIT_MS", "150"}});
    CHECK(c.FrameSyncEnabled());
    CHECK_STR_EQ(c.frameSyncPipe, "Z:\\tmp\\video.yuv");
    CHECK_STR_EQ(c.frameSyncStop, "Z:\\tmp\\stop");
    CHECK_STR_EQ(c.frameSyncAudio, "Z:\\tmp\\audio.pcm");
    CHECK_EQ(c.frameSyncStepDiv, 32);
    CHECK_EQ(c.FrameSyncStepDivOr(1024), 32);
    CHECK(c.frameSyncSkipPresent);
    CHECK(!c.frameSyncPipeline);
    CHECK(c.frameSyncThrottleWhileThreads);
    CHECK_EQ(c.frameSyncThreadMaxMs, 2500UL);
    CHECK_EQ(c.frameSyncAudioRefillWaitMs, 150UL);

    RuntimeConfig inv = ParseMap({{"FRAME_SYNC_PIPE", ""},
                                  {"FRAME_SYNC_STEP_DIV", "abc"},
                                  {"FRAME_SYNC_THREAD_MAX_MS", "-5"},
                                  {"FRAME_SYNC_AUDIO_REFILL_WAIT_MS", "-1"}});
    CHECK(!inv.FrameSyncEnabled());
    CHECK_EQ(inv.FrameSyncStepDivOr(1024), 1024);
    CHECK_EQ(inv.frameSyncThreadMaxMs, 10000UL);
    CHECK_EQ(inv.frameSyncAudioRefillWaitMs, 500UL);
}

TEST(VirtualClockMathConversions) {
    CHECK_EQ(virtual_clock::ComputeStepTicks(10000000LL, 1024), 162LL);
    CHECK_EQ(virtual_clock::ComputeStepTicks(1000LL, 1024), 1LL);  // 下限クランプ
    CHECK_EQ(virtual_clock::TicksToMs(5000000LL, 10000000LL), 500LL);
    CHECK_EQ(virtual_clock::MsToTicks(250ULL, 10000000LL), 2500000LL);
    CHECK_EQ(virtual_clock::WaitableDueToTicks(-166667LL, 10000000LL), 166667LL);
    CHECK_EQ(virtual_clock::WaitableDueToTicks(1000LL, 10000000LL), 0LL);

    const int64_t base = 50000000LL;
    CHECK_EQ(virtual_clock::FrameToMinVirtualTicks(base, 60, 10000000LL), base + 10000000LL);
    CHECK_EQ(virtual_clock::FrameToMinVirtualTicks(base, 90, 10000000LL), base + 15000000LL);

    CHECK_EQ(virtual_clock::FramesForSleepMs(0), 0LL);
    CHECK_EQ(virtual_clock::FramesForSleepMs(1), 1LL);
    CHECK_EQ(virtual_clock::FramesForSleepMs(16), 1LL);
    CHECK_EQ(virtual_clock::FramesForSleepMs(17), 2LL);
    CHECK_EQ(virtual_clock::FramesForSleepMs(1000), 60LL);
}

TEST(PixelFormatMappings) {
    using namespace present::capture;
    CHECK_STR_EQ(D3dPixFmtName(kD3DFMT_R8G8B8), "bgr24");
    CHECK_STR_EQ(D3dPixFmtName(kD3DFMT_A8R8G8B8), "bgr0");
    CHECK_STR_EQ(D3dPixFmtName(kD3DFMT_X8R8G8B8), "bgr0");
    CHECK_STR_EQ(D3dPixFmtName(kD3DFMT_R5G6B5), "rgb565le");
    CHECK_STR_EQ(D3dPixFmtName(kD3DFMT_X1R5G5B5), "rgb555le");
    CHECK(D3dPixFmtName(999) == nullptr);
    CHECK_EQ(D3dBytesPerPixel(kD3DFMT_R8G8B8), 3U);
    CHECK_EQ(D3dBytesPerPixel(kD3DFMT_R5G6B5), 2U);
    CHECK_EQ(D3dBytesPerPixel(kD3DFMT_A8R8G8B8), 4U);

    CHECK_STR_EQ(DxgiPixFmtName(kDXGI_FORMAT_R8G8B8A8_UNORM), "rgb0");
    CHECK_STR_EQ(DxgiPixFmtName(kDXGI_FORMAT_R8G8B8A8_UNORM_SRGB), "rgb0");
    CHECK_STR_EQ(DxgiPixFmtName(kDXGI_FORMAT_B8G8R8A8_UNORM), "bgr0");
    CHECK_STR_EQ(DxgiPixFmtName(kDXGI_FORMAT_B8G8R8X8_UNORM), "bgr0");
    CHECK_STR_EQ(DxgiPixFmtName(kDXGI_FORMAT_B8G8R8A8_UNORM_SRGB), "bgr0");
    CHECK(DxgiPixFmtName(0) == nullptr);
    CHECK_EQ(DxgiBytesPerPixel(kDXGI_FORMAT_B8G8R8A8_UNORM), 4U);
}

TEST(VirtualAudioMixMath) {
    using namespace audio::virtual_mix;
    CHECK(Near(DbHundredthsToGain(0), 1.0f));
    CHECK(Near(DbHundredthsToGain(-2000), 0.1f));
    CHECK(Near(DbHundredthsToGain(-20000), 1e-5f, 1e-6f));

    float gl = 0.0f, gr = 0.0f;
    PanHundredthsToGains(0, 0, &gl, &gr);
    CHECK(Near(gl, 1.0f) && Near(gr, 1.0f));
    PanHundredthsToGains(0, 2000, &gl, &gr);
    CHECK(Near(gl, 0.1f) && Near(gr, 1.0f));
    PanHundredthsToGains(0, -2000, &gl, &gr);
    CHECK(Near(gl, 1.0f) && Near(gr, 0.1f));

    CHECK_EQ(FloatToS16Clamp(0.0f), (short)0);
    CHECK_EQ(FloatToS16Clamp(1.0f), (short)32767);
    CHECK_EQ(FloatToS16Clamp(2.5f), (short)32767);
    CHECK_EQ(FloatToS16Clamp(-2.5f), (short)-32768);

    CHECK(!CrossedNotifyOffset(100, 100, 200, false));
    CHECK(CrossedNotifyOffset(200, 100, 200, false));
    CHECK(!CrossedNotifyOffset(201, 100, 200, false));
    CHECK(CrossedNotifyOffset(950, 900, 100, true));
    CHECK(CrossedNotifyOffset(50, 900, 100, true));
    CHECK(!CrossedNotifyOffset(500, 900, 100, true));
}
