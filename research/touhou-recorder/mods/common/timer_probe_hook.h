#pragma once
#include <windows.h>

// 診断専用: th20.exe自身がQueryPerformanceCounter/timeGetTime/
// GetSystemTimeAsFileTime/SetTimerをどの呼び出し元(return address)から
// どの頻度・引数で呼んでいるかをログに記録するIATフック。画面上のfpsカウンター
// 表示がどのタイマーAPI経由で計算されているかを特定するための調査用途のみに
// 使う(本番の録画パイプラインには組み込まない)。この調査の結果、
// mods/common/fps_display_hook.*でfpsカウンター表示補正の実装に至った
// (reports/48参照)。
//
// 注意: QueryPerformanceCounterのIATエントリはfps_display_hook.cppと同じ
// スロットのため、両方を同時にInstallすると後からフックした側の
// return address捕捉先が相手のフック関数内になってしまい正しく動作しない。
// 同時に有効化しないこと。
//
// 環境変数 TIMER_PROBE=1 が設定されている場合のみ有効化される。

namespace autoplay {

// InstallFpsLimiterHook() 等と同様、DLL_PROCESS_ATTACHの最初期に呼ぶこと。
void InstallTimerProbeHook();

} // namespace autoplay
