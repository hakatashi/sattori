#include "window_wait.h"
#include "dinput_hook.h"
#include "logging.h"

namespace autoplay {

struct FindWindowCtx {
    DWORD pid;
    HWND result;
};

static BOOL CALLBACK EnumWindowsProc(HWND hwnd, LPARAM lParam) {
    FindWindowCtx* ctx = (FindWindowCtx*)lParam;
    DWORD windowPid = 0;
    GetWindowThreadProcessId(hwnd, &windowPid);
    if (windowPid != ctx->pid) return TRUE;
    if (!IsWindowVisible(hwnd)) return TRUE;
    if (GetWindow(hwnd, GW_OWNER) != NULL) return TRUE; // トップレベルのみ
    if (GetWindowTextLengthA(hwnd) == 0) return TRUE;    // タイトルバー付きのみ

    ctx->result = hwnd;
    return FALSE; // 見つかったので打ち切り
}

static HWND FindMainWindowForPid(DWORD pid) {
    FindWindowCtx ctx = {pid, NULL};
    EnumWindows(EnumWindowsProc, (LPARAM)&ctx);
    return ctx.result;
}

HWND WaitForStableWindow(DWORD pid, unsigned int stableMs, unsigned int timeoutMs) {
    DWORD start = GetTickCount();
    HWND lastHwnd = NULL;
    DWORD lastChangeTick = start;

    while (GetTickCount() - start < timeoutMs) {
        HWND h = FindMainWindowForPid(pid);
        DWORD now = GetTickCount();

        if (h != lastHwnd) {
            if (lastHwnd == NULL && h != NULL) {
                Log("WaitForStableWindow: window appeared (hwnd=0x%p)", h);
            } else if (h != NULL) {
                Log("WaitForStableWindow: window recreated (old=0x%p new=0x%p)", lastHwnd, h);
            }
            lastHwnd = h;
            lastChangeTick = now;
        } else if (h != NULL && (now - lastChangeTick) >= stableMs) {
            Log("WaitForStableWindow: stable after %lu ms total", now - start);
            return h;
        }
        Sleep(100);
    }

    Log("WaitForStableWindow: TIMEOUT (last hwnd=0x%p)", lastHwnd);
    return lastHwnd;
}

bool WaitForHookActive(unsigned int timeoutMs) {
    DWORD start = GetTickCount();
    while (GetTickCount() - start < timeoutMs) {
        if (g_hookCallCount > 0) {
            Log("WaitForHookActive: GetDeviceState hook active after %lu ms (count=%ld)",
                GetTickCount() - start, g_hookCallCount);
            return true;
        }
        Sleep(100);
    }
    Log("WaitForHookActive: TIMEOUT (count=%ld)", g_hookCallCount);
    return false;
}

} // namespace autoplay
