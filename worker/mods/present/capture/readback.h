#pragma once
#include <windows.h>

// フレーム同期キャプチャのバックエンド契約(純粋POD・RTTI/libstdc++不要)。

namespace autoplay::present::capture {

class PipeWriter;

enum class CaptureStatus { kOk, kNoop, kError };

struct CaptureStats {
    LONGLONG readbackTicks = 0;
    LONGLONG writeTicks = 0;
    bool wroteFrame = false;
};

struct Backend {
    CaptureStatus (*capture)(void* target, LONGLONG presentCount, bool pipeline, PipeWriter* pipe,
                             CaptureStats* stats, const char** errWhy, HRESULT* errHr) = nullptr;
    void (*flush)(PipeWriter* pipe, CaptureStats* stats, const char** errWhy,
                  HRESULT* errHr) = nullptr;
    void (*onResize)(void* target, UINT width, UINT height, DWORD format, PipeWriter* pipe,
                     CaptureStats* stats, const char** errWhy, HRESULT* errHr) = nullptr;
};

}  // namespace autoplay::present::capture
