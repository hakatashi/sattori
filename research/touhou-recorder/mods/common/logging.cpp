#include "logging.h"
#include <cstdio>
#include <cstdarg>

namespace autoplay {

static char g_logPath[MAX_PATH] = {0};
static CRITICAL_SECTION g_logCs;
static bool g_logCsInit = false;

void LogInit(HMODULE hModule, const char* logFileName) {
    if (!g_logCsInit) {
        InitializeCriticalSection(&g_logCs);
        g_logCsInit = true;
    }

    char modulePath[MAX_PATH] = {0};
    GetModuleFileNameA(hModule, modulePath, MAX_PATH);

    // モジュールファイル自身と同じフォルダに置く
    char* lastSlash = strrchr(modulePath, '\\');
    if (lastSlash) {
        *(lastSlash + 1) = '\0';
    } else {
        modulePath[0] = '\0';
    }

    _snprintf_s(g_logPath, MAX_PATH, _TRUNCATE, "%s%s", modulePath, logFileName);

    // 起動のたびに新規ログにする
    FILE* f = nullptr;
    fopen_s(&f, g_logPath, "w");
    if (f) {
        fclose(f);
    }
}

void Log(const char* fmt, ...) {
    if (g_logPath[0] == '\0') return;

    char msg[1024];
    va_list args;
    va_start(args, fmt);
    _vsnprintf_s(msg, sizeof(msg), _TRUNCATE, fmt, args);
    va_end(args);

    SYSTEMTIME st;
    GetLocalTime(&st);

    if (g_logCsInit) EnterCriticalSection(&g_logCs);

    FILE* f = nullptr;
    fopen_s(&f, g_logPath, "a");
    if (f) {
        fprintf(f, "[%02d:%02d:%02d.%03d] %s\n", st.wHour, st.wMinute, st.wSecond, st.wMilliseconds, msg);
        fclose(f);
    }

    if (g_logCsInit) LeaveCriticalSection(&g_logCs);
}

} // namespace autoplay
