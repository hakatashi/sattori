#include "present/capture/d3d11_readback.h"

#ifdef _WIN64

#include <d3d11.h>
#include <dxgi1_2.h>

#include "audio/virtual/wasapi_mixer.h"
#include "clock/virtual_clock.h"
#include "core/log.h"
#include "core/log_contract.h"
#include "core/runtime_config.h"
#include "present/capture/frame_sync.h"
#include "present/capture/pipe_writer.h"
#include "present/capture/pixel_format.h"
#include "present/capture/readback.h"

namespace autoplay {

namespace {

using present::capture::CaptureStats;
using present::capture::CaptureStatus;
using present::capture::PipeWriter;

// -ldxguid に頼らず th06c でもリンクできるよう IID はここで定義する。
const GUID kIID_ID3D11Texture2D = {
    0x6f15aaf2, 0xd208, 0x4e89, {0x9a, 0xb4, 0x48, 0x95, 0x35, 0xd3, 0x4f, 0x9c}};
const GUID kIID_ID3D11Device = {
    0xdb6f6ddb, 0xac77, 0x4e88, {0x82, 0x53, 0x81, 0x9d, 0xf9, 0xbb, 0xf1, 0x40}};

IDXGISwapChain* g_capSc = nullptr;
ID3D11Device* g_dev = nullptr;
ID3D11DeviceContext* g_ctx = nullptr;
ID3D11Texture2D* g_staging[2] = {nullptr, nullptr};
int g_pendingIdx = -1;
UINT g_capW = 0;
UINT g_capH = 0;
DXGI_FORMAT g_capFmt = DXGI_FORMAT_UNKNOWN;
bool g_loggedCaptureStart = false;

bool WriteStaging(ID3D11Texture2D* tex, PipeWriter* pipe, CaptureStats* stats, const char** errWhy,
                  HRESULT* errHr) {
    LONGLONG t0 = virtual_clock::RealNow();
    D3D11_MAPPED_SUBRESOURCE mapped = {};
    HRESULT hr = g_ctx->Map(tex, 0, D3D11_MAP_READ, 0, &mapped);
    if (FAILED(hr) || !mapped.pData) {
        *errWhy = "ID3D11DeviceContext::Map failed";
        *errHr = hr;
        return false;
    }
    LONGLONG t1 = virtual_clock::RealNow();
    UINT rowBytes = g_capW * present::capture::DxgiBytesPerPixel((uint32_t)g_capFmt);
    bool ok = pipe->WriteRows((const BYTE*)mapped.pData, rowBytes, mapped.RowPitch, g_capH);
    DWORD writeErr = ok ? 0 : pipe->LastError();
    g_ctx->Unmap(tex, 0);
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

void FlushD3D11(PipeWriter* pipe, CaptureStats* stats, const char** errWhy, HRESULT* errHr) {
    if (g_pendingIdx < 0 || !g_staging[g_pendingIdx]) return;
    int idx = g_pendingIdx;
    g_pendingIdx = -1;
    WriteStaging(g_staging[idx], pipe, stats, errWhy, errHr);
}

void ReleaseResources() {
    for (int i = 0; i < 2; i++) {
        if (g_staging[i]) {
            g_staging[i]->Release();
            g_staging[i] = nullptr;
        }
    }
    if (g_ctx) {
        g_ctx->Release();
        g_ctx = nullptr;
    }
    if (g_dev) {
        g_dev->Release();
        g_dev = nullptr;
    }
    g_capSc = nullptr;
}

CaptureStatus CaptureD3D11(void* target, LONGLONG presentCount, bool pipeline, PipeWriter* pipe,
                           CaptureStats* stats, const char** errWhy, HRESULT* errHr) {
    auto* sc = (IDXGISwapChain*)target;
    if (g_capSc && g_capSc != sc) {
        Log("FrameSync: swapchain changed (%p -> %p), recreating staging", g_capSc, sc);
        FlushD3D11(pipe, stats, errWhy, errHr);
        ReleaseResources();
        if (*errWhy) return CaptureStatus::kError;
    }

    LONGLONG t0 = virtual_clock::RealNow();
    ID3D11Texture2D* bb = nullptr;
    HRESULT hr = sc->GetBuffer(0, kIID_ID3D11Texture2D, (void**)&bb);
    if (FAILED(hr) || !bb) {
        *errWhy = "IDXGISwapChain::GetBuffer failed";
        *errHr = hr;
        return CaptureStatus::kError;
    }

    D3D11_TEXTURE2D_DESC bd = {};
    bb->GetDesc(&bd);
    if (!g_staging[0]) {
        const char* pix = present::capture::DxgiPixFmtName((uint32_t)bd.Format);
        if (!pix) {
            bb->Release();
            *errWhy = "unsupported DXGI backbuffer format";
            *errHr = (HRESULT)bd.Format;
            return CaptureStatus::kError;
        }
        hr = sc->GetDevice(kIID_ID3D11Device, (void**)&g_dev);
        if (FAILED(hr) || !g_dev) {
            bb->Release();
            *errWhy = "IDXGISwapChain::GetDevice failed";
            *errHr = hr;
            return CaptureStatus::kError;
        }
        g_dev->GetImmediateContext(&g_ctx);
        if (!g_ctx) {
            bb->Release();
            *errWhy = "GetImmediateContext failed";
            *errHr = E_FAIL;
            return CaptureStatus::kError;
        }
        D3D11_TEXTURE2D_DESC sd = {};
        sd.Width = bd.Width;
        sd.Height = bd.Height;
        sd.MipLevels = 1;
        sd.ArraySize = 1;
        sd.Format = bd.Format;
        sd.SampleDesc.Count = 1;
        sd.SampleDesc.Quality = 0;
        sd.Usage = D3D11_USAGE_STAGING;
        sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        for (int i = 0; i < (pipeline ? 2 : 1); i++) {
            hr = g_dev->CreateTexture2D(&sd, nullptr, &g_staging[i]);
            if (FAILED(hr) || !g_staging[i]) {
                bb->Release();
                *errWhy = "CreateTexture2D(staging) failed";
                *errHr = hr;
                return CaptureStatus::kError;
            }
        }
        g_capSc = sc;
        g_capW = bd.Width;
        g_capH = bd.Height;
        g_capFmt = bd.Format;
        if (!g_loggedCaptureStart) {
            g_loggedCaptureStart = true;
            Log(log_contract::kFrameSyncCaptureStartFmt, g_capW, g_capH, (unsigned long)bd.Format,
                pix, (unsigned long)bd.SampleDesc.Count);
        } else {
            Log("FrameSync: recreated staging width=%u height=%u d3dfmt=%lu pix_fmt=%s", g_capW,
                g_capH, (unsigned long)bd.Format, pix);
        }
    } else if (bd.Width != g_capW || bd.Height != g_capH || bd.Format != g_capFmt) {
        bb->Release();
        *errWhy = "backbuffer size/format changed";
        *errHr = (HRESULT)bd.Format;
        return CaptureStatus::kError;
    }

    if (pipeline) {
        int cur = (int)(presentCount & 1);
        g_ctx->CopyResource(g_staging[cur], bb);
        bb->Release();
        int prev = g_pendingIdx;
        g_pendingIdx = cur;
        stats->readbackTicks += virtual_clock::RealNow() - t0;
        if (prev >= 0 && !WriteStaging(g_staging[prev], pipe, stats, errWhy, errHr)) {
            return CaptureStatus::kError;
        }
        return CaptureStatus::kOk;
    }

    g_ctx->CopyResource(g_staging[0], bb);
    bb->Release();
    stats->readbackTicks += virtual_clock::RealNow() - t0;
    if (!WriteStaging(g_staging[0], pipe, stats, errWhy, errHr)) return CaptureStatus::kError;
    return CaptureStatus::kOk;
}

void OnResizeD3D11(void* target, UINT w, UINT h, DWORD fmt, PipeWriter* pipe, CaptureStats* stats,
                   const char** errWhy, HRESULT* errHr) {
    auto* sc = (IDXGISwapChain*)target;
    if (sc != g_capSc) return;
    Log("FrameSync: ResizeBuffers (%ux%u fmt=%lu), resetting staging", w, h, (unsigned long)fmt);
    FlushD3D11(pipe, stats, errWhy, errHr);
    ReleaseResources();
}

}  // namespace

bool InstallFrameSyncD3D11(int stepDiv) {
    if (!Config().FrameSyncEnabled()) return false;
    audio::wasapi_mixer::Install();

    present::capture::Backend backend;
    backend.capture = &CaptureD3D11;
    backend.flush = &FlushD3D11;
    backend.onResize = &OnResizeD3D11;

    virtual_clock::Options clockOpt;
    clockOpt.stepDiv = stepDiv;
    clockOpt.trackThreads = false;
    clockOpt.hookWaitableTimers = true;
    clockOpt.silentInit = true;

    return frame_sync::Install(backend, clockOpt, "D3D11");
}

}  // namespace autoplay

#endif  // _WIN64
