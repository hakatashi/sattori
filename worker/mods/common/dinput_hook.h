#pragma once
#include <windows.h>

// 東方Project (TH06〜TH09系) 向け DirectInput GetDeviceState vtable フック。
// 詳細は docs/touhou_menu_automation.md を参照。
//
// フック連鎖:
//   IAT フック: DINPUT8.dll!DirectInput8Create
//     -> vtable フック: IDirectInput8A::CreateDevice (vtable[3])
//       -> vtable フック: IDirectInputDevice8A::GetDeviceState (vtable[9])
//
// GetDeviceState が返す BYTE[256] 生バッファの該当バイトを 0x80 に
// 書き換えることでメニュー・ゲームプレイ両方にキー入力を注入する。

namespace autoplay {

// GetDeviceState フックが実際に呼ばれた回数(DirectInputが初期化されメニュー
// ループに入ったことの検出に使う)
extern volatile LONG g_hookCallCount;

// InstallDinputHook() は DLL_PROCESS_ATTACH の最初期(ゲームが
// DirectInput8Create を呼ぶ前)に呼ぶこと。IAT を走査して書き換えるだけの
// 処理なので、ローダーロック下でも安全に実行できる。
bool InstallDinputHook();

// dik (DirectInput スキャンコード) を holdFrames 回分の GetDeviceState 呼び出し
// (=描画フレーム)だけ押しっぱなしにし、その後 releaseFrames 回分離した状態を
// 保ってから戻る。
//
// ミリ秒ではなく「GetDeviceStateの呼び出し回数」を基準にしているのは、
// タイトルによって実効fpsが大きく異なる(実機検証ではth07が垂直同期ありの
// 約60fps、th08が垂直同期なしで約900fps超と、同じ「100ms」でも該当する
// フレーム数が10倍以上変わることを確認した)ため。固定ミリ秒だとfpsの高い
// タイトルでキーを何十フレームも押しっぱなしにしてしまい、ゲーム側のカーソル
// 移動オートリピートが誤発動して意図しないメニュー項目に飛んでしまう
// (th08で実際に発生した不具合)。フレーム数基準にすることでfpsに依存せず
// 「ちょうど1回分の入力」を再現できる。
//
// timeoutMs は hookが停止する等の異常時に無限待機しないための安全装置。
// GetDeviceState フックが実際に呼ばれるまでバッファは書き換わらないため、
// 呼び出し元は別スレッド(DllMain以外)から呼ぶこと。
void PressKey(BYTE dik, unsigned int holdFrames = 4, unsigned int releaseFrames = 4,
              unsigned int timeoutMs = 2000);

} // namespace autoplay
