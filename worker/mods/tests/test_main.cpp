#include "tests/test.h"
#include <fstream>

namespace modtest {

std::vector<Case>& Registry() {
    static std::vector<Case> cases;
    return cases;
}
int g_failures = 0;

std::vector<std::string> ReadLines(const char* path) {
    std::vector<std::string> lines;
    std::ifstream f(path);
    if (!f) {
        std::printf("  cannot open %s\n", path);
        ++g_failures;
        return lines;
    }
    std::string line;
    while (std::getline(f, line)) lines.push_back(line);
    return lines;
}

}  // namespace modtest

int main() {
    int failedCases = 0;
    for (const auto& c : modtest::Registry()) {
        int before = modtest::g_failures;
        c.fn();
        bool ok = modtest::g_failures == before;
        if (!ok) failedCases++;
        std::printf("%s %s\n", ok ? "ok  " : "FAIL", c.name);
    }
    std::printf("%zu tests, %d failed\n", modtest::Registry().size(), failedCases);
    return failedCases == 0 ? 0 : 1;
}
