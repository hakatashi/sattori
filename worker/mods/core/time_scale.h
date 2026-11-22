#pragma once
#ifdef _WIN32
#include <windows.h>
#endif
#include "core/runtime_config.h"

// メニュー自動操作の待ち時間の倍率(Issue #393 で3系統を1つにした)。
//
// 各タイトルのメニュー操作は「キーを押してから画面遷移アニメーションが終わるまで」を Sleep() の
// 実時間で待つ。アニメーションはゲーム内時間(フレーム)で進むので、録画速度が等倍でないときは
// 待ちを同じ比率で伸縮しないと、ゲーム内時間での待ちが等倍とずれる:
//   - 倍速録画(FPS_LIMIT_TARGET_HZ=120 など): 待ちがゲーム内時間でN倍に伸び、等倍へ戻した動画で
//     メニュー操作が1/Nの速度に見えた(本番E2E、th10の2倍速、Issue #288)
//   - 低速録画(FPS_LIMIT_TARGET_HZ=30 など): 待ちが短すぎてアニメーション完了前に次のキーを送り、
//     操作が空振りした(th20のスローモーション化PoC)
// そこで Menu() = 60 / FPS_LIMIT_TARGET_HZ を掛ける。倍速時の SPEED_HACK_MULTIPLIER は
// ワーカーが同じ FPS_LIMIT_TARGET_HZ から導出する(=FPS_LIMIT_TARGET_HZ/60)ので、旧 MenuSleep の
// 1/SPEED_HACK_MULTIPLIER と同じ値になる。
//
// **ウィンドウ出現・フック有効化の待ちのような、実時間で進む処理のタイムアウトには Menu() を
// 使わないこと**。2倍速でth09の起動待ちを15秒に縮めたところ本番E2Eでタイムアウトした
// (docs/reports/2026-10-02-speedup-production-e2e.md)。タイムアウトには StartupTimeout() を使う
// (伸ばす方向にだけ効く。ワーカー側の scaled_timeout_sec() と同じ考え方)。
//
// 手動の検証で fps が極端に落ちる環境(GPUの無い th06nc を等倍で動かすと約10fps)では、
// MENU_WAIT_EXTRA_SCALE でメニュー待ちだけをさらに伸ばせる(core/runtime_config.h)。

namespace autoplay::time_scale {

// 純粋な写像(テスト用)。targetHz<=0 は等倍。extra は手動の検証用の MENU_WAIT_EXTRA_SCALE。
inline double MenuScaleFor(double targetHz, double extra = 1.0) {
    return (targetHz > 0.0 ? 60.0 / targetHz : 1.0) * extra;
}
inline unsigned long StartupTimeoutFor(unsigned long baseMs, double targetHz) {
    double s = MenuScaleFor(targetHz);
    return s > 1.0 ? (unsigned long)(baseMs * s) : baseMs;
}

#ifdef _WIN32
inline double Menu() { return MenuScaleFor(Config().fpsLimitTargetHz, Config().menuWaitExtraScale); }

// メニュー操作の待ちを差し替えるハンドラ(フレーム同期時はフレーム数基準に切り替え)。
using MenuSleepHandler = void (*)(unsigned long baseMs);
void SetMenuSleepHandler(MenuSleepHandler handler);

// メニュー操作の待ち。
void MenuSleep(unsigned long baseMs);

// 実時間で進む処理(起動・ウィンドウ生成・入力ポーリング開始)の待ちの上限。低速録画でだけ伸ばす。
inline unsigned long StartupTimeout(unsigned long baseMs) {
    return StartupTimeoutFor(baseMs, Config().fpsLimitTargetHz);
}
#endif

}  // namespace autoplay::time_scale
