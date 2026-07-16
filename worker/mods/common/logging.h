#pragma once
#include <windows.h>

namespace autoplay {

// hModule 自身の DLL ファイルと同じフォルダに logFileName でログファイルを作る
void LogInit(HMODULE hModule, const char* logFileName);
void Log(const char* fmt, ...);

} // namespace autoplay
