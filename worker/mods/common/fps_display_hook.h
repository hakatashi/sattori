#pragma once
#include <windows.h>

// th20の画面上fpsカウンター表示を、FPS_LIMIT_TARGET_HZによるスローモーション化
// (fps_limiter_hook.h参照)の影響から切り離して「等倍相当」の値に見せかけるフック。
//
// 背景(reports/47・48参照): FPS_LIMIT_TARGET_HZでPresentを間引いてth20を
// スローモーション化すると、ゲーム内蔵fpsカウンターは実測通り正直に低い値
// (例: 30.0fps)を表示する。scripts/47_descale_th20_slowmo.pyで録画後に映像・
// 音声とも「等倍相当」に変換できるが、画面に焼き付いたfpsカウンターの数値
// テキスト自体は録画時の値のまま残ってしまい、変換後の動画と数値表示が
// 食い違う問題があった。
//
// 調査(reports/48、mods/common/timer_probe_hook.*で発見): th20.exeが
// QueryPerformanceCounterを呼ぶ複数の呼び出し元のうち、フレームごとに正確に
// 3回呼ばれる呼び出し元(rva=0x0001cb54)を偽装すると、画面上のfpsカウンター
// 表示が実際に補正後の値(例: FPS_LIMIT_TARGET_HZ=30で「60.0fps」)に変わる
// ことを実機確認した。
//
// 別の呼び出し元(rva=0x00141875)はフレームごとに正確に1回だけ呼ばれ、実際の
// Present呼び出し頻度(fps_limiter_hookでスロットルされた後の実測レート)と
// 厳密に1:1で相関していたため当初これがfpsカウンター用だと推測したが、この
// 呼び出し元だけを偽装してもfps表示は変化しなかった(恐らく内部フレーム
// ペーシング/自己スロットル用の計測で、表示とは別用途)。さらに、この
// rva=0x00141875を含む全QueryPerformanceCounter呼び出し元を無差別に偽装する
// 実験ではth20がハングした(GetDeviceStateポーリングが完全停止し、メニュー
// 操作もリプレイ再生も一切進行しなくなった)。恐らくこの呼び出し元が
// 「実時間で一定時間経過するまで待つ」自己スロットルのwait判定に使われており、
// 偽装によって「いつまで経っても閾値に達しない」スピンループに陥ったためと
// 推測される。この経緯から、対象呼び出し元を実証済みの1箇所(rva=0x0001cb54)
// だけに限定する現在の実装は、正確さだけでなく安全性の面でも重要。
//
// 対策: rva=0x0001cb54から呼ばれたQueryPerformanceCounterの戻り値だけを
// 「実時間の経過ペースをFPS_LIMIT_TARGET_HZ/60倍(スローモーション化の逆数)で
// 早回しした偽の値」にすり替える。fps_limiter_hook自身が使うQueryPerformanceCounter
// (Present呼び出しの実ペーシング)は本フックの対象外(g_origQPCを直接呼ぶため
// 素のAPIを使い、フックの影響を受けない)なので、実際の負荷軽減効果(Present
// 間引き)自体には影響しない。実機検証(reports/48)では、本フック有効時も
// th20.exeプロセスのCPU使用率は補正無し時と同水準(平均251%、フェーズ47の
// 30fps条件の平均266%と近い値)を維持し、GetDeviceStateポーリング頻度も
// 目標fps通り(30.0Hz付近)で安定していることを確認済み。
//
// 既知の制約: rva=0x0001cb54はth20.exe(検証時点のバイナリ)固有のオフセットの
// ハードコードであり、ゲームデータが更新されバイナリが変わると別の値になる
// 可能性がある(AGENTS.mdのcfgフルスクリーンフラグの教訓と同様、実機で
// 都度確認すること)。想定外のth20.exeバイナリで一致しなかった場合は単に
// 何も補正されない(素のQueryPerformanceCounterと同じ値を返す)だけで、実害は
// 無い。また、変換後動画に焼き付くのは「録画時にth20自身が表示していた値」
// であり、本フック導入後は録画時点で既に「等倍相当」の値が焼き付くため、
// scripts/47_descale_th20_slowmo.pyによる後処理後もfps表示と実際の滑らかさが
// 一致するようになる。

namespace autoplay {

// InstallFpsLimiterHook() 等と同様、DLL_PROCESS_ATTACHの最初期に呼ぶこと。
// FPS_LIMIT_TARGET_HZ環境変数からスケール(targetHz/60.0)を算出する
// (未設定または60の場合はscale=1.0で実質無効化、fps_limiter_hook.cppと同じ方針)。
bool InstallFpsDisplayCorrectionHook();

} // namespace autoplay
