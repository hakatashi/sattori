// 同期マーカーの系列(audio/sync_marker_sequence.h)が、ゴールデン(tests/sync_marker_golden.txt)と
// 一致するか。同じゴールデンを worker/tests/test_mod_log_contract.py が worker/recording/sync_marker.py
// の marker_sequence() で確かめるので、MODとワーカーの系列が食い違えばどちらかが落ちる。
#include "audio/sync_marker_sequence.h"
#include "tests/test.h"
#include <cstdlib>
#include <map>

using namespace autoplay::sync_marker;

namespace {

std::map<std::string, std::string> ReadGolden() {
    std::map<std::string, std::string> kv;
    for (const auto& line : modtest::ReadLines("sync_marker_golden.txt")) {
        if (line.empty() || line[0] == '#') continue;
        auto eq = line.find('=');
        if (eq != std::string::npos) kv[line.substr(0, eq)] = line.substr(eq + 1);
    }
    return kv;
}

}  // namespace

TEST(SyncMarkerSequenceMatchesGolden) {
    auto golden = ReadGolden();
    Sequence seq;
    std::string first64;
    uint64_t positives = 0;
    uint64_t fnv = 1469598103934665603ULL;  // FNV-1a(64bit)を ±1 の符号ビット(1/0)の列に掛ける
    for (uint32_t i = 0; i < kSamples; i++) {
        int v = seq.Next();
        CHECK(v == kAmp || v == -kAmp);
        bool pos = v > 0;
        if (i < 64) first64 += pos ? '+' : '-';
        positives += pos;
        fnv ^= (uint64_t)(pos ? 1 : 0);
        fnv *= 1099511628211ULL;
    }
    char fnvHex[32];
    std::snprintf(fnvHex, sizeof(fnvHex), "%016llx", (unsigned long long)fnv);
    CHECK_STR_EQ(std::to_string(kSamples), golden["samples"]);
    CHECK_STR_EQ(std::to_string(kSeed), std::to_string(std::strtoul(golden["seed"].c_str(), nullptr, 16)));
    CHECK_STR_EQ(std::to_string(kAmp), golden["amp"]);
    CHECK_STR_EQ(first64, golden["first64"]);
    CHECK_STR_EQ(std::to_string(positives), golden["positives"]);
    CHECK_STR_EQ(fnvHex, golden["fnv1a64"]);
}
