#pragma once
#include <windows.h>

// タイトルの画面上fpsカウンター表示を、FPS_LIMIT_TARGET_HZによるスローモーション化
// (fps_limiter_hook.h参照)の影響から切り離して「等倍相当」の値に見せかけるフック。
//
// 背景(reports/47・48参照): FPS_LIMIT_TARGET_HZでPresentを間引いてスローモーション化
// すると、ゲーム内蔵fpsカウンターは実測通り正直に低い値(例: 30.0fps)を表示する。
// scripts/47_descale_th20_slowmo.pyで録画後に映像・音声とも「等倍相当」に変換できるが、
// 画面に焼き付いたfpsカウンターの数値テキスト自体は録画時の値のまま残ってしまい、
// 変換後の動画と数値表示が食い違う問題があった。
//
// th20の調査(reports/48、mods/common/timer_probe_hook.*で発見): th20.exeが
// QueryPerformanceCounterを呼ぶ複数の呼び出し元のうち、フレームごとに正確に
// 3回呼ばれる呼び出し元(rva=0x0001cb54)を偽装すると、画面上のfpsカウンター
// 表示が実際に補正後の値(例: FPS_LIMIT_TARGET_HZ=30で「60.0fps」)に変わる
// ことを実機確認した。別の呼び出し元(rva=0x00141875、フレームごとに正確に1回、
// 恐らく内部フレームペーシング/自己スロットル用)を誤って対象にした初回実装では
// 表示は変化せず、さらにその呼び出し元を含め全QueryPerformanceCounter呼び出し元を
// 無差別に時刻偽装する実験ではth20がハング(GetDeviceStateポーリングが完全停止)した。
// この経緯から、対象呼び出し元を実証済みの1箇所に限定する現在の実装は、正確さ
// だけでなく安全性の面でも重要。
//
// 既知の制約: targetRvaは対象ゲームの実行ファイル(検証時点のバイナリ)固有の
// オフセットのハードコードであり、ゲームデータが更新されバイナリが変わると別の値に
// なる可能性がある。想定外のバイナリで一致しなかった場合は単に何も補正されない
// (素のAPIと同じ値を返す)だけで、実害は無い。

namespace autoplay {

// DLL_PROCESS_ATTACHの最初期に呼ぶこと。FPS_LIMIT_TARGET_HZ環境変数から
// スケール(targetHz/60.0)を算出する(未設定または60の場合はscale=1.0で
// 実質無効化、fps_limiter_hook.cppと同じ方針)。
//
// targetRvaは対象ゲームの実行ファイル(image base 0x400000)内で、フレームごとの
// fpsカウンター表示計算に使われていると実証済みのQueryPerformanceCounter
// 呼び出し元のRVA。ゲームごとに異なる値になる(th20はreports/48の調査で
// 0x0001cb54と判明、他タイトルは同様の手順(mods/common/timer_probe_hook.*)で
// 別途特定する必要がある)。
bool InstallFpsDisplayCorrectionHook(ULONG_PTR targetRva);

// th09(touhou-recorder reports/69調査)向け: fps表示計算にQueryPerformanceCounter
// ではなくWINMM.dll!timeGetTime(ミリ秒精度)を使っているタイトル向けの版。ロジックは
// InstallFpsDisplayCorrectionHookと同一(対象コールサイトのみ、実経過時間を
// FPS_LIMIT_TARGET_HZ/60倍に圧縮した偽の値にすり替える)。QueryPerformanceCounter
// 版とtimeGetTime版は別々のIATスロットのため、両方同時に有効化しても干渉しない。
bool InstallFpsDisplayCorrectionHookTimeGetTime(ULONG_PTR targetRva);

} // namespace autoplay
