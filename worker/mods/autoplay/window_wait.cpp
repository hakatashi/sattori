#include "autoplay/window_wait.h"
#include "core/log.h"
#include "core/log_contract.h"
#include <wchar.h>

namespace autoplay {

struct FindWindowCtx {
    DWORD pid;
    WindowFilter filter;
    HWND result;
};

static BOOL CALLBACK EnumWindowsProc(HWND hwnd, LPARAM lParam) {
    FindWindowCtx* ctx = (FindWindowCtx*)lParam;
    DWORD windowPid = 0;
    GetWindowThreadProcessId(hwnd, &windowPid);
    if (windowPid != ctx->pid) return TRUE;
    if (!IsWindowVisible(hwnd)) return TRUE;
    if (GetWindow(hwnd, GW_OWNER) != NULL) return TRUE; // トップレベルのみ

    if (ctx->filter == WindowFilter::kDxlib) {
        if (GetWindowTextLengthW(hwnd) == 0) return TRUE;  // タイトルバー付きのみ
        wchar_t cls[64] = {0};
        GetClassNameW(hwnd, cls, 64);
        if (wcscmp(cls, L"#32770") == 0) return TRUE;  // 起動ダイアログは対象外
        RECT rc{};
        if (GetClientRect(hwnd, &rc) && (rc.right - rc.left) < 320) return TRUE;
    } else {
        if (GetWindowTextLengthA(hwnd) == 0) return TRUE;  // タイトルバー付きのみ
    }

    ctx->result = hwnd;
    return FALSE; // 見つかったので打ち切り
}

static HWND FindMainWindowForPid(DWORD pid, WindowFilter filter) {
    FindWindowCtx ctx = {pid, filter, NULL};
    EnumWindows(EnumWindowsProc, (LPARAM)&ctx);
    return ctx.result;
}

HWND WaitForStableWindow(DWORD pid, unsigned int stableMs, unsigned int timeoutMs,
                         WindowFilter filter) {
    DWORD start = GetTickCount();
    HWND lastHwnd = NULL;
    DWORD lastChangeTick = start;

    while (GetTickCount() - start < timeoutMs) {
        HWND h = FindMainWindowForPid(pid, filter);
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
            Log(log_contract::kWindowStableFmt, (unsigned long)(now - start));
            return h;
        }
        Sleep(100);
    }

    Log("WaitForStableWindow: TIMEOUT (last hwnd=0x%p)", lastHwnd);
    return lastHwnd;
}

} // namespace autoplay
