#pragma once
#include <windows.h>

// キー入力の注入の共通部。ゲームが入力をポーリングする関数(GetDeviceState / GetKeyboardState /
// GetAsyncKeyState)のフックが、呼ばれるたびに counter を1進め、keys[k] が立っているキーを
// 押下状態に書き換える。押す側は「ポーリングの回数(=描画フレーム)」を単位に押し離しする。
//
// ミリ秒ではなくポーリング回数を基準にしているのは、タイトルによって実効fpsが大きく異なる
// (実機検証ではth07が垂直同期ありの約60fps、th08が垂直同期なしで約900fps超と、同じ「100ms」でも
// 該当するフレーム数が10倍以上変わることを確認した)ため。固定ミリ秒だとfpsの高い
// タイトルでキーを何十フレームも押しっぱなしにしてしまい、ゲーム側のカーソル
// 移動オートリピートが誤発動して意図しないメニュー項目に飛んでしまう
// (th08で実際に発生した不具合)。
//
// フックが実際に呼ばれるまでキーは反映されないため、DllMain以外の別スレッドから呼ぶこと。

namespace autoplay::key_inject {

// counter が start から frames 回分進むか、timeoutMs 経過するまで待つ(異常時の安全装置)。
inline void WaitPolls(volatile LONG* counter, LONG start, unsigned int frames, unsigned int timeoutMs) {
    DWORD t0 = GetTickCount();
    while ((LONG)(*counter - start) < (LONG)frames) {
        if (GetTickCount() - t0 >= timeoutMs) return;
        Sleep(1);
    }
}

// key を holdFrames 回分のポーリングだけ押しっぱなしにし、その後 releaseFrames 回分離した
// 状態を保ってから戻る。
inline void Press(volatile LONG* counter, volatile BYTE* keys, BYTE key, unsigned int holdFrames,
                  unsigned int releaseFrames, unsigned int timeoutMs) {
    LONG holdStart = *counter;
    keys[key] = 1;
    WaitPolls(counter, holdStart, holdFrames, timeoutMs);

    LONG releaseStart = *counter;
    keys[key] = 0;
    WaitPolls(counter, releaseStart, releaseFrames, timeoutMs);
}

}  // namespace autoplay::key_inject
