// 時刻の写像(clock/time_warp.h)・メニュー待ちの倍率(core/time_scale.h)・環境変数の読み取り
// (core/runtime_config.h)。
#include "clock/time_warp.h"
#include "core/runtime_config.h"
#include "core/time_scale.h"
#include "tests/test.h"
#include <map>

using namespace autoplay;

TEST(TimeWarpCounterScalesElapsedFromBase) {
    CHECK_EQ(time_warp::Counter(1000, 1000, 2.0), (int64_t)1000);
    CHECK_EQ(time_warp::Counter(1000, 1600, 2.0), (int64_t)2200);
    CHECK_EQ(time_warp::Counter(1000, 1600, 0.5), (int64_t)1300);
    CHECK_EQ(time_warp::Counter(1000, 1600, 1.0), (int64_t)1600);
    // 実時間で10分(10MHz)、3倍速。64bitでも桁あふれしない
    const int64_t base = 123456789012345LL, tenMin = 600LL * 10000000LL;
    CHECK_EQ(time_warp::Counter(base, base + tenMin, 3.0), base + 3 * tenMin);
}

TEST(TimeWarpMillisSurvivesWraparound) {
    // timeGetTime が一周(2^32ms)をまたいでも、経過時間は差で取るので正しく伸びる
    CHECK_EQ(time_warp::Millis(0xFFFFFF00u, 0x00000100u, 2.0), (uint32_t)0x00000300u);
    CHECK_EQ(time_warp::Millis(5000u, 6000u, 2.0), (uint32_t)7000u);
    CHECK_EQ(time_warp::Millis(5000u, 6001u, 0.5), (uint32_t)5500u);  // 切り捨て
}

TEST(MenuScaleShrinksOnlyForSpeedup) {
    CHECK(time_scale::MenuScaleFor(0.0) == 1.0);    // 未設定 = 等倍
    CHECK(time_scale::MenuScaleFor(60.0) == 1.0);
    CHECK(time_scale::MenuScaleFor(120.0) == 0.5);  // 2倍速。旧 MenuSleep の 1/SPEED_HACK_MULTIPLIER と同じ
    CHECK(time_scale::MenuScaleFor(180.0) == 1.0 / 3.0);
    CHECK(time_scale::MenuScaleFor(30.0) == 1.0);   // 低速録画は廃止した(Issue #391)。伸ばさない
    CHECK(time_scale::MenuScaleFor(0.0, 7.0) == 7.0);  // 手動の検証用の追加倍率
    CHECK(time_scale::MenuScaleFor(120.0, 2.0) == 1.0);
}

namespace {
RuntimeConfig Parse(std::map<std::string, std::string> env) {
    return ParseRuntimeConfig([&](const char* name) -> const char* {
        auto it = env.find(name);
        return it == env.end() ? nullptr : it->second.c_str();
    });
}
}  // namespace

TEST(RuntimeConfigDefaults) {
    RuntimeConfig c = Parse({});
    CHECK(c.fpsLimitTargetHz == 0.0);
    CHECK(c.TargetHzOr(60.0) == 60.0);
    CHECK(c.speedHackMultiplier == 1.0);
    CHECK(c.syncMarkerTrigger[0] == '\0');
    CHECK(!c.d3d11DecodeBc7);
    CHECK(!c.d3dxAreaFilterDisabled);
    CHECK(c.menuWaitExtraScale == 1.0);
}

TEST(RuntimeConfigParsesValues) {
    RuntimeConfig c = Parse({{"FPS_LIMIT_TARGET_HZ", "120"},
                             {"SPEED_HACK_MULTIPLIER", "2"},
                             {"SYNC_MARKER_TRIGGER", "Z:\\tmp\\sync_marker.trigger"},
                             {"D3D11_DECODE_BC7", "1"},
                             {"D3DX_AREA_FILTER", "0"},
                             {"MENU_WAIT_EXTRA_SCALE", "7"}});
    CHECK(c.fpsLimitTargetHz == 120.0);
    CHECK(c.TargetHzOr(60.0) == 120.0);
    CHECK(c.speedHackMultiplier == 2.0);
    CHECK_STR_EQ(c.syncMarkerTrigger, "Z:\\tmp\\sync_marker.trigger");
    CHECK(c.d3d11DecodeBc7);
    CHECK(c.d3dxAreaFilterDisabled);
    CHECK(c.menuWaitExtraScale == 7.0);
}

TEST(RuntimeConfigIgnoresInvalidValues) {
    // 0以下・数値でないものは未設定と同じ(旧実装の `atof(env) > 0.0` の判定と同じ)
    RuntimeConfig c = Parse({{"FPS_LIMIT_TARGET_HZ", "0"},
                             {"SPEED_HACK_MULTIPLIER", "abc"},
                             {"D3D11_DECODE_BC7", "0"},
                             {"D3DX_AREA_FILTER", "1"}});
    CHECK(c.fpsLimitTargetHz == 0.0);
    CHECK(c.speedHackMultiplier == 1.0);
    CHECK(!c.d3d11DecodeBc7);
    CHECK(!c.d3dxAreaFilterDisabled);
    c = Parse({{"FPS_LIMIT_TARGET_HZ", "-30"}, {"SPEED_HACK_MULTIPLIER", "-1"}});
    CHECK(c.fpsLimitTargetHz == 0.0);
    CHECK(c.speedHackMultiplier == 1.0);
}

TEST(RuntimeConfigTruncatesLongTriggerPath) {
    std::string longPath(400, 'a');
    RuntimeConfig c = Parse({{"SYNC_MARKER_TRIGGER", longPath}});
    CHECK_EQ(std::string(c.syncMarkerTrigger).size(), sizeof(c.syncMarkerTrigger) - 1);
}
