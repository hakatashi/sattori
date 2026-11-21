#pragma once
#include <windows.h>

#include "clock/virtual_clock.h"
#include "present/capture/readback.h"

// フレーム同期キャプチャのコーディネータ(D3D8/D3D9・D3D11 共通)。
//
// present/bus のハンドラ(kPriorityFrameSync)として登録され、
//   1. Present 毎に仮想時計を進め(最初の Present で仮想時計を開始)
//   2. バックエンド経由でバックバッファを読み出して PipeWriter へ書き
//   3. 仮想音声ミキサが登録されていれば同じフレーム数だけ PCM を書き
//   4. 未解除中・スレッド読み込み中の kThrottle と DXGI syncInterval=0 / kSkip を制御する。

namespace autoplay::frame_sync {

struct AudioHooks {
    void (*mixFrame)(bool write) = nullptr;
    void (*close)() = nullptr;
};

// 仮想音声ミキサ(dsound_mixer / wasapi_mixer)を登録する。
void SetAudioHooks(const AudioHooks& hooks);

// FRAME_SYNC_PIPE が設定されている場合のみ有効化して true を返す。
bool Install(const present::capture::Backend& backend,
             const virtual_clock::Options& clockOptions, const char* backendName);

bool Active();
void SetUnthrottled(bool unthrottled);
void SleepMs(unsigned long ms);
void WaitPresentFrames(int frames);

}  // namespace autoplay::frame_sync
