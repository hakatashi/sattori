#pragma once
#include <windows.h>

// 倍速録画(issue #1)向けの時間偽装フック。
//
// 背景: th15はSleep()やSetTimer()ではなく、メインループ内で
// QueryPerformanceCounter()をビジーポーリングして次フレームの時刻に
// 達したかを判定する方式でフレームレート(≒ゲーム内ロジック更新速度)を
// 制御している(TIMER_PROBE=1での実機調査で判明、rva=0x00072ccbから
// 2秒あたり300〜900回のQPC呼び出しを確認、reports/85)。
//
// fps_limiter_hook.h(Present呼び出しをスロットルする方式)は「上限を
// 抑える」方向にしか効かず、GPU環境で描画が十分速くてもQPCベースの
// フレームレート制御が60fpsで頭打ちになるため倍速化できなかった
// (FPS_LIMIT_TARGET_HZ=120でもGetDeviceState呼び出し頻度・スコア/グレイズ
// 進行ペースがネイティブ実行と完全に一致することを実測で確認)。
//
// 本フックはQueryPerformanceCounterの返り値そのものを書き換え、
// 「基準時刻からの経過時間をmultiplier倍に伸長して返す」ことで、
// ゲームに実際より速く時間が経過していると錯覚させる(スピードハック
// 技術の定番手法)。ゲームのメインループがQPCを絶対時刻の基準として
// フレームレートを計算している限り、レンダリングとロジック更新の
// 両方が連動してmultiplier倍速で進行するはず。

namespace autoplay {

// InstallFpsLimiterHook() 等と同様、DLL_PROCESS_ATTACHの最初期に呼ぶこと。
// 環境変数 SPEED_HACK_MULTIPLIER (例: "2.0") が優先される。未設定または
// 1.0以下ならno-op(フックせずそのまま動作させる)。
bool InstallSpeedHackHook(double multiplier = 1.0);

// GetProcAddressでtimeGetTimeを動的に取得するエンジン(th06nc)向け。InstallSpeedHackHook()の
// 後に呼ぶこと。倍率1.0ならrealをそのまま返す。
void* WrapTimeGetTimeForSpeedHack(void* real);
void* WrapQueryPerformanceCounterForSpeedHack(void* real);

} // namespace autoplay
