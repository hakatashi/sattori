#pragma once
#include <windows.h>

// 東方Project(32bitタイトル)向けのキー入力注入。
//
// フック連鎖:
//   IAT フック: DINPUT8.dll!DirectInput8Create
//     -> vtable フック: IDirectInput8A::CreateDevice (vtable[3])
//       -> vtable フック: IDirectInputDevice8A::GetDeviceState (vtable[9])
//
// GetDeviceState が返す BYTE[256] 生バッファの該当バイトを 0x80 に
// 書き換えることでメニュー・ゲームプレイ両方にキー入力を注入する。
//
// TH10以降のエンジンの一部(th11・th20で確認)はこの経路を実際の入力ポーリングに使わないため
// (下記InstallKeyboardStateHook参照)、対象タイトルに応じてどちらか一方、または
// 両方を併用する。押し離しの単位(ポーリング回数)は input/key_inject.h。

namespace autoplay {

// GetDeviceState / GetKeyboardState フックが実際に呼ばれた回数(DirectInputが初期化されメニュー
// ループに入ったことの検出に使う)
extern volatile LONG g_hookCallCount;

// InstallDinputHook() は DLL_PROCESS_ATTACH の最初期(ゲームが
// DirectInput8Create を呼ぶ前)に呼ぶこと。
bool InstallDinputHook();

// dik (DirectInput スキャンコード) を holdFrames 回分の GetDeviceState 呼び出し
// (=描画フレーム)だけ押しっぱなしにし、その後 releaseFrames 回分離した状態を
// 保ってから戻る。timeoutMs は hookが停止する等の異常時に無限待機しないための安全装置。
void PressKey(BYTE dik, unsigned int holdFrames = 4, unsigned int releaseFrames = 4,
              unsigned int timeoutMs = 2000);

// TH10以降のエンジンの一部(th11・th20で確認)向け: USER32.dll!GetKeyboardState の IAT フック。
// これらのタイトルはDirectInputデバイスを作成する(CreateDevice/GetDeviceStateの
// フックは掛かる)ものの、実際の入力ポーリングはWin32の GetKeyboardState() 経由で
// 行っており、GetDeviceStateフックだけでは一切呼ばれない(g_hookCallCountが0の
// まま)ことをth11で確認した(touhou-recorder reports/35)。
//
// GetDeviceStateフックと同じ g_hookCallCount を共有するため、WaitForHookActive は
// どちらの経路が実際に使われるゲームでも変更なしに動作する。
bool InstallKeyboardStateHook();

// vk (Win32 仮想キーコード、例: VK_DOWN=0x28, VK_RETURN=0x0D) を GetKeyboardState の
// 呼び出し回数を単位に押し離しする。意味・引数はPressKey()と同じ。
void PressVKey(BYTE vk, unsigned int holdFrames = 4, unsigned int releaseFrames = 4,
               unsigned int timeoutMs = 2000);

// g_hookCallCount が 0 より大きくなる (= GetDeviceState / GetKeyboardState フックが最低1回
// 呼ばれた = 入力が初期化されメニューループに入った) まで待つ。
bool WaitForHookActive(unsigned int timeoutMs);

} // namespace autoplay
