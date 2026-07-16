#pragma once
#include <windows.h>

namespace autoplay {

// pid の可視トップレベルウィンドウが出現し、stableMs の間 HWND が変化しなく
// なるまで待つ (東方タイトルの多くは起動直後にウィンドウを再作成するため)。
// timeoutMs 経過した場合はその時点で見つかっている HWND (NULL の場合もある)
// を返す。
HWND WaitForStableWindow(DWORD pid, unsigned int stableMs, unsigned int timeoutMs);

// g_hookCallCount が 0 より大きくなる (= GetDeviceState フックが最低1回
// 呼ばれた = DirectInputが初期化されメニューループに入った) まで待つ。
bool WaitForHookActive(unsigned int timeoutMs);

} // namespace autoplay
