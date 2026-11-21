#pragma once
#include <windows.h>

// DirectSoundの使い方を記録する診断用フック(reports/106)。DSOUND_PROBE=1 のときだけ有効。
//
// フレーム同期キャプチャ(reports/105)で音声を録るには、ゲームがBGM・効果音をどう鳴らして
// いるか(バッファの作り方、ストリーミングの補充を何で起こしているか、どのスレッドが
// 何を呼ぶか)を知る必要がある。dsound_hookのCreateSoundBufferフックから呼ばれ、
// セカンダリバッファのvtableと、exeのIATの WaitForSingleObject・Sleep・CreateThread を
// 記録用のフックへ差し替える。
//
// MODログ(すべて "DSProbe:" で始まる):
//   buffer #N created ...            作成時の形式・大きさ・フラグ・呼び出し元(RVA)・スレッド
//   #N <Method> ...                  各バッファ・各メソッドの最初の数十回の詳細
//   notify #N count=K offsets=...    SetNotificationPositions(通知位置とイベント)
//   wait tid=T handle=... (#N:k) ... 通知イベントでのWaitForSingleObject(最初の数十回)
//   thread tid=T start=<module>+RVA  初めて見たスレッドの開始アドレス(メインスレッドはexeのエントリ)
//   window ... / buf #N ... / thr T ...  5秒ごとの集計(呼び出し回数・書き込み量・待ち)
//
// 時刻はすべて実時間(フック外のQueryPerformanceCounter)。ゲームの時計を偽装する他のフックと
// 併用しても集計の時間軸は変わらない。

namespace autoplay {

// InstallDSoundHook() の後、DLL_PROCESS_ATTACH の中で呼ぶ。DSOUND_PROBE 未設定なら何もしない。
bool InstallDSoundProbeHook();

// dsound_hook.cpp が定義する、CreateSoundBuffer成功直後のコールバック(未登録ならnullptr)。
extern void (*g_dsoundBufferCreatedCallback)(void* buffer, const void* desc, bool isPrimary,
                                              void* returnAddress);
extern void (*g_dsoundBufferDuplicatedCallback)(void* original, void* duplicate,
                                                void* returnAddress);

} // namespace autoplay
