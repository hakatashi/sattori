#pragma once
// MODの単体テスト(ホストの g++、`make -C worker/mods test`)の最小限の枠組み。
// Win32 に依存しないロジックだけをテストする。テストは tests/test_*.cpp に TEST(...) で書く。
#include <cstdio>
#include <cstdint>
#include <string>
#include <vector>

namespace modtest {

struct Case {
    const char* name;
    void (*fn)();
};
std::vector<Case>& Registry();
extern int g_failures;

inline int Register(const char* name, void (*fn)()) {
    Registry().push_back({name, fn});
    return 0;
}

// テストのデータファイル(tests/ からの相対パス。`make test` は tests/ で実行する)を行ごとに読む。
std::vector<std::string> ReadLines(const char* path);

}  // namespace modtest

#define TEST(name)                                                                   \
    static void name();                                                              \
    [[maybe_unused]] static const int name##_registered = modtest::Register(#name, name); \
    static void name()

#define CHECK(cond)                                                                  \
    do {                                                                             \
        if (!(cond)) {                                                               \
            std::printf("  %s:%d: CHECK(%s) failed\n", __FILE__, __LINE__, #cond);   \
            ++modtest::g_failures;                                                   \
        }                                                                            \
    } while (0)

#define CHECK_EQ(a, b)                                                               \
    do {                                                                             \
        auto va_ = (a);                                                              \
        auto vb_ = (b);                                                              \
        if (!(va_ == vb_)) {                                                         \
            std::printf("  %s:%d: CHECK_EQ(%s, %s) failed: %s != %s\n", __FILE__, __LINE__, #a, #b, \
                        std::to_string(va_).c_str(), std::to_string(vb_).c_str());   \
            ++modtest::g_failures;                                                   \
        }                                                                            \
    } while (0)

#define CHECK_STR_EQ(a, b)                                                           \
    do {                                                                             \
        std::string va_ = (a);                                                       \
        std::string vb_ = (b);                                                       \
        if (va_ != vb_) {                                                            \
            std::printf("  %s:%d: CHECK_STR_EQ failed:\n    got:      \"%s\"\n    expected: \"%s\"\n", \
                        __FILE__, __LINE__, va_.c_str(), vb_.c_str());               \
            ++modtest::g_failures;                                                   \
        }                                                                            \
    } while (0)
