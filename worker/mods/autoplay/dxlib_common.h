#pragma once
#include <windows.h>

// th06c(東方紅魔郷: Classic)・th06nc(同 New Classic)の共通部。どちらも DXライブラリ系エンジンの
// 64bit(PE32+)バイナリで、入力・時刻・音声・D3D11 の関数を GetProcAddress で動的に取得する
// (touhou-recorder reports/74・75・78)。タイトル固有の違い(起動ダイアログの有無、メニューの
// カーソル位置のRVA、スコアのRVA)は各 dllmain.cpp に残す。

namespace autoplay::dxlib {

struct Options {
    // GetAsyncKeyState も差し替える(th06nc)
    bool hookAsyncKeyState = false;
};

// GetProcAddress の横取り(入力・倍速録画の時刻・DirectSound・CoCreateInstance)と、exe の IAT の
// CoCreateInstance(exe には無く FAILED になるが念のため)を組み込む。DLL_PROCESS_ATTACH で、
// InstallSpeedHackHook()・InstallWasapiHook() の前に呼ぶ。タイトル固有の差し替え(th06nc の D3D11)は
// 呼び出し側が procaddr::Override で足す(DllMain の中なら Install の前後どちらでもよい)。
void InstallHooks(const Options& options);

// pid の可視な起動ダイアログ(クラス #32770)。無ければ null。
HWND FindStartupDialog(DWORD pid);

}  // namespace autoplay::dxlib
