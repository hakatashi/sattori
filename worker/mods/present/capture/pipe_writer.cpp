#include "present/capture/pipe_writer.h"

namespace autoplay::present::capture {

bool PipeWriter::Open(const char* path) {
    if (pipe_ != INVALID_HANDLE_VALUE) return true;
    pipe_ =
        CreateFileA(path, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
                    0, nullptr);
    if (pipe_ == INVALID_HANDLE_VALUE) {
        lastError_ = GetLastError();
        return false;
    }
    lastError_ = 0;
    return true;
}

void PipeWriter::Close() {
    if (pipe_ != INVALID_HANDLE_VALUE) {
        CloseHandle(pipe_);
        pipe_ = INVALID_HANDLE_VALUE;
    }
}

bool PipeWriter::WriteAll(const BYTE* data, DWORD size) {
    while (size > 0) {
        DWORD written = 0;
        if (!WriteFile(pipe_, data, size, &written, nullptr) || written == 0) {
            lastError_ = GetLastError();
            return false;
        }
        data += written;
        size -= written;
    }
    return true;
}

bool PipeWriter::WriteRows(const BYTE* bits, UINT rowBytes, UINT pitch, UINT height) {
    if (pitch == rowBytes) return WriteAll(bits, rowBytes * height);
    for (UINT y = 0; y < height; y++) {
        if (!WriteAll(bits + (size_t)y * pitch, rowBytes)) return false;
    }
    return true;
}

}  // namespace autoplay::present::capture
