#pragma once
#include <windows.h>

// フレーム同期キャプチャ用の仮想時計(D3D8/D3D9 と D3D11/DXGI 共通)。
//
// 最初の Present まで実時間を通し、Enter() が呼ばれた瞬間からメインスレッドの時計だけを
// Present と Sleep に合わせて進める。他スレッド(BGM補充など)は時計を進めず、Sleep も
// 実時間のまま動く。

namespace autoplay::virtual_clock {

struct Options {
    int stepDiv = 1024;
    bool trackThreads = false;
    bool hookWaitableTimers = false;
    bool silentInit = false;  // ローダーロック下(th06nc)ではログを出さない
};

// FRAME_SYNC_PIPE が設定されているときだけ IAT フックを入れて true を返す。
bool Install(const Options& options);
bool IsActive();

// Present 開始時に一度だけ呼ぶ。以降は呼び出し元スレッドがメインスレッドとして扱われる。
void Enter();
bool IsVirtualMode();

// Present 完了後に呼ぶ。仮想時刻を少なくとも frame/60 秒相当まで進める。
void AdvanceToFrame(LONGLONG frame);

// 本物の QPC 時刻と周波数(フックの影響を受けない)。
LONGLONG RealNow();
LONGLONG Freq();
DWORD MainThreadId();

// スレッド追跡(trackThreads=true のとき有効)。
void RecordPresentFrame(LONGLONG frame);
int CountLiveThreads();

// MySleep の先頭で呼ばれるフィルタ。true を返すと仮想/実時間 Sleep を行わず即座に抜ける。
using SleepFilter = bool (*)(unsigned long ms);
void SetSleepFilter(SleepFilter filter);

// DXライブラリ (GetProcAddress 経由) 向けのラッパ。
void* WrapQueryPerformanceCounter(void* real);
void* WrapTimeGetTime(void* real);
void* WrapGetTickCount(void* real);
void* WrapGetTickCount64(void* real);
void* WrapSleep(void* real);
void* WrapWaitForSingleObject(void* real);

}  // namespace autoplay::virtual_clock
