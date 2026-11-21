#pragma once
#include <windows.h>

// th06c/th06nc(DXライブラリ系エンジン)向けのキー入力注入。
//
// DXライブラリは User32.dll を LoadLibrary + GetProcAddress で動的に解決してから
// GetKeyboardState を呼ぶため、IATフック(input/dinput の InstallKeyboardStateHook)では一切
// 引っかからない(touhou-recorder reports/74・75)。そこで GetProcAddress を横取りし
// (core/pe_iat.h の procaddr)、入力APIの解決要求に対して自前の関数を返す。

namespace autoplay::dxlib {

// 「1フレーム分の入力」の基準にするポーリング回数。ゲームが実際に使っている
// 経路(GetKeyboardState / GetAsyncKeyState のどちら、あるいは両方)の呼び出し回数を数える。
extern volatile LONG g_pollCount;

// procaddr に入力APIの差し替えを登録する(procaddr::Install() より前に呼ぶ)。
// hookAsyncKeyState: GetAsyncKeyState も差し替える(th06nc。実機ではGetKeyboardStateのみが
// 使われる(reports/78)が、将来の挙動変化に備えて両方をフックしてある)。
void RegisterInputOverrides(bool hookAsyncKeyState);

// vk を holdFrames 回分のポーリングだけ押下状態にし、releaseFrames 回分離す
// (input/key_inject.h)。
void PressVKey(BYTE vk, unsigned int holdFrames = 1, unsigned int releaseFrames = 2,
               unsigned int timeoutMs = 2000);

}  // namespace autoplay::dxlib
