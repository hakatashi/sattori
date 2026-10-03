#pragma once
#include <windows.h>
#include <stdlib.h>

// メニュー自動操作の待ち時間(Issue #288、倍速録画)。
//
// 各タイトルのメニュー操作は「キーを押してから画面遷移アニメーションが終わるまで」を
// Sleep()の実時間で待っている。倍速録画ではゲームがN倍速で進むのに、Sleep()は
// スピードハック(QPC偽装)の対象外なので、待ちがゲーム内時間でN倍に伸びる。等倍へ戻した
// 動画ではメニュー操作が1/Nの速度に見えた(本番E2E、th10の2倍速)。ゲーム内時間での
// 待ちを等倍と揃えるため、倍速時だけ1/Nにする。
//
// SPEED_HACK_MULTIPLIER(倍速録画でだけワーカーが設定する、speed_hack_hook.h)を見る。
// 低速録画(FPS_LIMIT_TARGET_HZ<60)の待ち時間は変えない。ウィンドウ出現・フック有効化の
// 待ちのような**実時間で進む処理のタイムアウトには使わないこと**(th09で起動待ちが
// 縮んで失敗した、docs/reports/2026-10-02-speedup-production-e2e.md)。

namespace autoplay {

inline double MenuWaitScale() {
    static double scale = -1.0;
    if (scale < 0.0) {
        const char* env = getenv("SPEED_HACK_MULTIPLIER");
        double multiplier = env ? atof(env) : 1.0;
        scale = multiplier > 1.0 ? 1.0 / multiplier : 1.0;
    }
    return scale;
}

inline void MenuSleep(DWORD ms) { Sleep((DWORD)(ms * MenuWaitScale())); }

} // namespace autoplay
