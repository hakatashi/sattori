// core/log_contract.h の書式で、ゴールデン(tests/log_contract_golden.txt)の各行を再現できるか。
// 同じゴールデンを worker/tests/test_mod_log_contract.py が Python の正規表現で読む。書式を変えたら
// ゴールデンも書き換え、Python 側のテストが通ることを確かめること。
#include "core/log_contract.h"
#include "tests/test.h"
#include <cstdio>

using namespace autoplay::log_contract;

namespace {

std::string Prefixed(int h, int m, int s, int ms, const std::string& msg) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), kLinePrefixFmt, h, m, s, ms);
    return buf + msg;
}

template <typename... Args>
std::string Format(const char* fmt, Args... args) {
    char buf[512];
    std::snprintf(buf, sizeof(buf), fmt, args...);
    return buf;
}

}  // namespace

TEST(LogContractMatchesGolden) {
    std::vector<std::string> expected = modtest::ReadLines("log_contract_golden.txt");
    std::vector<std::string> got = {
        Prefixed(1, 2, 3, 4, Format(kStepFmt, 5, "Enter (confirm playback, start replay)")),
        Prefixed(1, 2, 3, 905, Format(kSequenceCompleteFmt, "th12")),
        Prefixed(23, 59, 58, 7, Format(kWindowStableFmt, 1234UL)),
        Prefixed(12, 0, 0, 0,
                 Format(kScoreMonitorFmt, 3122125ULL, 7, 2, 345, 1763700000123ULL)),
        Prefixed(12, 0, 1, 500,
                 Format(kSyncMarkerPlayedFmt, 1763700000.123456, 0.000789, 88200UL, 131072UL, 256,
                        0x2545F491UL, 0UL)),
    };
    CHECK_EQ(got.size(), expected.size());
    for (size_t i = 0; i < got.size() && i < expected.size(); i++) CHECK_STR_EQ(got[i], expected[i]);
}
