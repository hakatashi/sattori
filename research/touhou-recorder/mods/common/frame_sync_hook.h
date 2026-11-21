#pragma once
#include <windows.h>

// フレーム同期キャプチャ(reports/104・105)。
//
// ゲームを実時間で動かして外からx11grabで取り込む代わりに、ゲームの1フレームごとに
// バックバッファを読み出してパイプへ書き、書き終わりしだい次のフレームへ進める。
// 描画と取り込み(エンコード)の遅いほうが律速になり、軽い場面は速く、重い場面は遅く進む。
// 取り込みはPresent 1回につき必ず1フレームなので、落ちフレームは原理的に起きない。
//
// 構成:
//   1. 仮想時計: exeのIATの QueryPerformanceCounter / timeGetTime / GetTickCount / Sleep を
//      差し替える。最初のPresent以降、時刻は実時間と無関係になり、メインスレッド(Presentを
//      呼ぶスレッド)がタイマーを読むたびに少しずつ、Sleep(n)を呼ぶとnミリ秒進む。
//      ゲーム内蔵のフレームレート制御(QPCのポーリングやSleep)は実時間を消費せずに抜け、
//      ゲームから見た1フレームは常に約1/60秒になる。他のスレッドは時計を進めず読むだけで、
//      Sleepも実時間のまま(BGMの補充スレッド等を空回りさせないため)。
//   2. 取り込み: fps_limiter_hookのPresentフックから呼ばれるコールバックで、
//      GetBackBuffer → GetRenderTargetData(システムメモリのサーフェスへ) → LockRect し、
//      環境変数 FRAME_SYNC_PIPE のパス(録画側が作ったFIFO)へ生のフレームを書く。
//      パイプが詰まればWriteFileがブロックするので、それがそのまま律速になる。
//   3. 速度の切り替え: 既定では fps_limiter_hook の上限(実時間60Hz)が効いたまま。
//      FrameSyncSetUnthrottled(true) を呼ぶと上限を外す。起動〜メニュー操作は実時間で進む
//      処理(ロードスレッド、MODのSleep基準のキー操作)に依存するので等速のままにし、
//      リプレイ再生を始めてから外す。
//
// 環境変数:
//   FRAME_SYNC_PIPE  取り込み先FIFOのWindows形式パス(Z:\...)。未設定なら全体が無効(何もしない)
//   FRAME_SYNC_STOP  このファイルが現れたら取り込みを止めてパイプを閉じる(録画側の停止要求)
//   FRAME_SYNC_PIPELINE=0         読み出しの1フレーム遅延(パイプライン化、既定で有効)を切る。
//                                 有効時は、今のフレームの読み出しを積んでから1つ前のフレームを
//                                 書き出すので、描画とゲーム本体・書き込みが並行して進む
//   FRAME_SYNC_SKIP_PRESENT=1     上限を外している間、本来のPresentを呼ばない(Xの画面は更新されない)
//   FRAME_SYNC_PROBE_READBACK2=1  診断用。毎フレーム読み出しを2回行い、2回目(描画の完了待ちを
//                                 含まない、読み出しそのものの時間)をstatsのreadback2_msに出す
//   FRAME_SYNC_PROBE_NO_READBACK=1 診断用。読み出しをせず黒いフレームを書く(描画だけの速度の上限)
//
// MODログ:
//   FrameSync: capture start width=W height=H d3dfmt=F pix_fmt=bgr0   最初のフレームの直前
//   FrameSync: stats frame=N ... fps=X ...                            600フレームごと
//   FrameSync: capture stopped frames_written=N                       停止時
//
// 音声は frame_sync_audio(MOD内の仮想音声デバイス、FRAME_SYNC_AUDIO設定時)が、取り込んだ
// フレームと同じ数だけ735サンプルずつ書く(reports/107)。

namespace autoplay {

// DLL_PROCESS_ATTACHの最初期に、InstallFpsLimiterHook()より前に呼ぶこと。
// FRAME_SYNC_PIPE未設定なら何もせずfalseを返す。
bool InstallFrameSyncHook(int stepDiv = 1024);

// フレーム同期キャプチャが有効か(FRAME_SYNC_PIPEが設定されているか)。
bool FrameSyncActive();

// trueで実時間60Hzの上限を外す(描画・取り込みが許す限り速く進める)。
void FrameSyncSetUnthrottled(bool unthrottled);

// フレーム同期有効時は実時間のSleep()ではなくPresent回数(60fps換算)で待機する。
// 待機終了時点で短期ロードスレッドが動作中であればその終了も待つ。
void FrameSyncSleepMs(DWORD ms);

// fps_limiter_hook.cpp が定義するPresent前後のコールバック。
// 前: 戻り値は下のフラグの組み合わせ。
//   kPresentThrottle  その回のフレームレート上限の待ちを行う(立っていなければ待たない)
//   kPresentSkip      本来のPresent(画面への転送)を呼ばない
const int kPresentThrottle = 1;
const int kPresentSkip = 2;
extern int (*g_d3d9PrePresentCallback)(void* device);
extern void (*g_d3d9PostPresentCallback)(void* device);
extern int (*g_d3d8PrePresentCallback)(void* device);
extern void (*g_d3d8PostPresentCallback)(void* device);

} // namespace autoplay
