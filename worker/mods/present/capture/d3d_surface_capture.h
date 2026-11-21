#pragma once
#include <windows.h>

#include "clock/virtual_clock.h"
#include "core/log.h"
#include "core/log_contract.h"
#include "present/capture/pipe_writer.h"
#include "present/capture/pixel_format.h"
#include "present/capture/readback.h"

// D3D8 / D3D9 共通のシステムメモリサーフェス読み出しロジック。
// vtable番号・メソッドシグネチャの差分だけを D3dOps で受け取る。
// (-static を使わない32bit DLL でも __cxa_guard が入らないよう自明なPOD初期化にする)

namespace autoplay::present::capture {

struct D3dSurfaceInfo {
    UINT width;
    UINT height;
    DWORD format;
    DWORD multisample;
};

struct D3dLockedRect {
    INT pitch;
    void* bits;
};

struct D3dOps {
    const char* createSurfaceName;
    const char* copyName;
    int lockIdx;
    int unlockIdx;
    void (*hookRasterStatus)(void* dev);
    HRESULT (*acquireBackBuffer)(void* dev, void** outBb, D3dSurfaceInfo* outInfo);
    HRESULT (*createSysSurface)(void* dev, UINT w, UINT h, DWORD fmt, void** outSurf);
    HRESULT (*copyToSysSurface)(void* dev, void* bb, void* surf);
};

class D3dSurfaceCapturer {
   public:
    CaptureStatus Capture(const D3dOps& ops, void* dev, LONGLONG presentCount, bool pipeline,
                          PipeWriter* pipe, CaptureStats* stats, const char** errWhy,
                          HRESULT* errHr) {
        ops.hookRasterStatus(dev);
        if (!ResetOnDeviceChange(ops, dev, pipe, stats, errWhy, errHr)) {
            return CaptureStatus::kError;
        }

        LONGLONG t0 = virtual_clock::RealNow();
        void* bb = nullptr;
        D3dSurfaceInfo info = {};
        HRESULT hr = ops.acquireBackBuffer(dev, &bb, &info);
        if (FAILED(hr) || !bb) {
            *errWhy = "GetBackBuffer failed";
            *errHr = hr;
            return CaptureStatus::kError;
        }

        if (!sysSurf_) {
            const char* pix = D3dPixFmtName(info.format);
            if (!pix) {
                ReleaseCom(bb);
                *errWhy = "unsupported backbuffer format";
                *errHr = (HRESULT)info.format;
                return CaptureStatus::kError;
            }
            hr = ops.createSysSurface(dev, info.width, info.height, info.format, &sysSurf_);
            if (FAILED(hr) || !sysSurf_) {
                ReleaseCom(bb);
                *errWhy = ops.createSurfaceName;
                *errHr = hr;
                return CaptureStatus::kError;
            }
            capW_ = info.width;
            capH_ = info.height;
            capFmt_ = info.format;
            bytesPerPixel_ = D3dBytesPerPixel(info.format);
            if (!loggedCaptureStart_) {
                loggedCaptureStart_ = true;
                // 録画側はこの行を見て ffmpeg の rawvideo 入力形式を決める(最初のフレームより先に出す)。
                Log(log_contract::kFrameSyncCaptureStartFmt, capW_, capH_,
                    (unsigned long)info.format, pix, (unsigned long)info.multisample);
            } else {
                Log("FrameSync: recreated surfaces width=%u height=%u d3dfmt=%lu pix_fmt=%s",
                    capW_, capH_, (unsigned long)info.format, pix);
            }
        } else if (info.width != capW_ || info.height != capH_ || info.format != capFmt_) {
            ReleaseCom(bb);
            *errWhy = "backbuffer size/format changed";
            *errHr = (HRESULT)info.format;
            return CaptureStatus::kError;
        }

        if (pipeline) {
            int cur = (int)(presentCount & 1);
            if (!surfs_[cur]) {
                if (cur == 0) {
                    surfs_[0] = sysSurf_;
                } else {
                    hr = ops.createSysSurface(dev, info.width, info.height, info.format,
                                              &surfs_[1]);
                    if (FAILED(hr) || !surfs_[1]) {
                        ReleaseCom(bb);
                        *errWhy = ops.createSurfaceName;
                        *errHr = hr;
                        return CaptureStatus::kError;
                    }
                }
            }
            hr = ops.copyToSysSurface(dev, bb, surfs_[cur]);
            ReleaseCom(bb);
            if (FAILED(hr)) {
                *errWhy = ops.copyName;
                *errHr = hr;
                return CaptureStatus::kError;
            }
            int prev = pendingSurf_;
            pendingSurf_ = cur;
            stats->readbackTicks += virtual_clock::RealNow() - t0;
            if (prev >= 0 && !WriteSurface(ops, surfs_[prev], pipe, stats, errWhy, errHr)) {
                return CaptureStatus::kError;
            }
            return CaptureStatus::kOk;
        }

        hr = ops.copyToSysSurface(dev, bb, sysSurf_);
        ReleaseCom(bb);
        if (FAILED(hr)) {
            *errWhy = ops.copyName;
            *errHr = hr;
            return CaptureStatus::kError;
        }
        stats->readbackTicks += virtual_clock::RealNow() - t0;
        if (!WriteSurface(ops, sysSurf_, pipe, stats, errWhy, errHr)) return CaptureStatus::kError;
        return CaptureStatus::kOk;
    }

    void Flush(const D3dOps& ops, PipeWriter* pipe, CaptureStats* stats, const char** errWhy,
               HRESULT* errHr) {
        if (pendingSurf_ < 0) return;
        int idx = pendingSurf_;
        pendingSurf_ = -1;
        WriteSurface(ops, surfs_[idx], pipe, stats, errWhy, errHr);
    }

   private:
    typedef ULONG(WINAPI* Release_t)(void*);
    typedef HRESULT(WINAPI* LockRect_t)(void* surf, D3dLockedRect* lr, const RECT* rect,
                                        DWORD flags);
    typedef HRESULT(WINAPI* UnlockRect_t)(void* surf);

    static inline void** VT(void* obj) { return *(void***)obj; }
    static void ReleaseCom(void* obj) {
        if (obj) ((Release_t)VT(obj)[2])(obj);
    }

    bool ResetOnDeviceChange(const D3dOps& ops, void* newDev, PipeWriter* pipe,
                             CaptureStats* stats, const char** errWhy, HRESULT* errHr) {
        if (capDev_ == newDev) return true;
        if (capDev_ != nullptr) {
            Log("FrameSync: device changed (%p -> %p), recreating surfaces", capDev_, newDev);
            Flush(ops, pipe, stats, errWhy, errHr);
            if (*errWhy) return false;
            if (surfs_[0] && surfs_[0] != sysSurf_) ReleaseCom(surfs_[0]);
            if (surfs_[1] && surfs_[1] != sysSurf_) ReleaseCom(surfs_[1]);
            ReleaseCom(sysSurf_);
            surfs_[0] = surfs_[1] = sysSurf_ = nullptr;
        }
        capDev_ = newDev;
        return true;
    }

    bool WriteSurface(const D3dOps& ops, void* surf, PipeWriter* pipe, CaptureStats* stats,
                      const char** errWhy, HRESULT* errHr) {
        constexpr DWORD kD3DLOCK_READONLY = 0x10;
        LONGLONG t0 = virtual_clock::RealNow();
        D3dLockedRect lr = {};
        HRESULT hr = ((LockRect_t)VT(surf)[ops.lockIdx])(surf, &lr, nullptr, kD3DLOCK_READONLY);
        if (FAILED(hr) || !lr.bits) {
            *errWhy = "LockRect failed";
            *errHr = hr;
            return false;
        }
        LONGLONG t1 = virtual_clock::RealNow();
        UINT rowBytes = capW_ * bytesPerPixel_;
        bool ok = pipe->WriteRows((const BYTE*)lr.bits, rowBytes, (UINT)lr.pitch, capH_);
        DWORD writeErr = ok ? 0 : pipe->LastError();
        ((UnlockRect_t)VT(surf)[ops.unlockIdx])(surf);
        if (!ok) {
            *errWhy = "WriteFile to pipe failed";
            *errHr = (HRESULT)writeErr;
            return false;
        }
        stats->readbackTicks += t1 - t0;
        stats->writeTicks += virtual_clock::RealNow() - t1;
        stats->wroteFrame = true;
        return true;
    }

    void* capDev_ = nullptr;
    void* sysSurf_ = nullptr;
    void* surfs_[2] = {nullptr, nullptr};
    int pendingSurf_ = -1;
    UINT capW_ = 0;
    UINT capH_ = 0;
    DWORD capFmt_ = 0;
    UINT bytesPerPixel_ = 4;
    bool loggedCaptureStart_ = false;
};

}  // namespace autoplay::present::capture
