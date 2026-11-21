#pragma once
#include <windows.h>

// フレーム同期キャプチャの FIFO パイプ書き込みラッパ。

namespace autoplay::present::capture {

class PipeWriter {
   public:
    bool IsOpen() const { return pipe_ != INVALID_HANDLE_VALUE; }
    bool Open(const char* path);
    void Close();

    bool WriteAll(const BYTE* data, DWORD size);
    bool WriteRows(const BYTE* bits, UINT rowBytes, UINT pitch, UINT height);
    DWORD LastError() const { return lastError_; }

   private:
    HANDLE pipe_ = INVALID_HANDLE_VALUE;
    DWORD lastError_ = 0;
};

}  // namespace autoplay::present::capture
