#include "present/capture/d3d9_readback.h"

#include "audio/virtual/dsound_mixer.h"
#include "clock/virtual_clock.h"
#include "core/log.h"
#include "core/runtime_config.h"
#include "core/vtable_hook.h"
#include "present/bus.h"
#include "present/capture/d3d_surface_capture.h"
#include "present/capture/frame_sync.h"

namespace autoplay {

namespace {

using present::capture::CaptureStats;
using present::capture::CaptureStatus;
using present::capture::D3dLockedRect;
using present::capture::D3dOps;
using present::capture::D3dSurfaceCapturer;
using present::capture::D3dSurfaceInfo;
using present::capture::PipeWriter;

struct SurfDesc9 {
    DWORD Format, Type, Usage, Pool, MultiSampleType, MultiSampleQuality, Width, Height;
};
struct RasterStatus {
    BOOL InVBlank;
    UINT ScanLine;
};

typedef HRESULT(WINAPI* GetBackBuffer9_t)(void* dev, UINT swapChain, UINT backBuffer, DWORD type,
                                          void** surf);
typedef HRESULT(WINAPI* GetRasterStatus9_t)(void* dev, UINT swapChain, RasterStatus* status);
typedef HRESULT(WINAPI* GetRenderTargetData_t)(void* dev, void* rt, void* dst);
typedef HRESULT(WINAPI* CreateOffscreenPlainSurface_t)(void* dev, UINT w, UINT h, DWORD fmt,
                                                       DWORD pool, void** surf, HANDLE* shared);
typedef HRESULT(WINAPI* GetDesc9_t)(void* surf, SurfDesc9* d);

GetRasterStatus9_t g_origGetRasterStatus = nullptr;

HRESULT WINAPI MyGetRasterStatus(void* dev, UINT swapChain, RasterStatus* status) {
    if (!virtual_clock::IsVirtualMode()) {
        return g_origGetRasterStatus ? g_origGetRasterStatus(dev, swapChain, status) : 0;
    }
    if (status) {
        status->InVBlank = TRUE;
        status->ScanLine = 0;
    }
    return 0;
}

void HookRasterStatus(void* dev) {
    if (vtable::HookObject(dev, 19, &MyGetRasterStatus, &g_origGetRasterStatus)) {
        Log("FrameSync: hooked GetRasterStatus (vtable[19])");
    }
}

HRESULT AcquireBackBuffer(void* dev, void** outBb, D3dSurfaceInfo* outInfo) {
    void** vt = vtable::Of(dev);
    HRESULT hr = ((GetBackBuffer9_t)vt[18])(dev, 0, 0, 0 /*MONO*/, outBb);
    if (FAILED(hr) || !*outBb) return hr;
    SurfDesc9 d = {};
    ((GetDesc9_t)vtable::Of(*outBb)[12])(*outBb, &d);
    *outInfo = {d.Width, d.Height, d.Format, d.MultiSampleType};
    return hr;
}

HRESULT CreateSysSurface(void* dev, UINT w, UINT h, DWORD fmt, void** outSurf) {
    constexpr DWORD kD3DPOOL_SYSTEMMEM = 2;
    return ((CreateOffscreenPlainSurface_t)vtable::Of(dev)[36])(dev, w, h, fmt, kD3DPOOL_SYSTEMMEM,
                                                                outSurf, nullptr);
}

HRESULT CopyToSysSurface(void* dev, void* bb, void* surf) {
    return ((GetRenderTargetData_t)vtable::Of(dev)[32])(dev, bb, surf);
}

const D3dOps kOps = {
    "CreateOffscreenPlainSurface failed",
    "GetRenderTargetData failed",
    /*lockIdx=*/13,
    /*unlockIdx=*/14,
    &HookRasterStatus,
    &AcquireBackBuffer,
    &CreateSysSurface,
    &CopyToSysSurface,
};
D3dSurfaceCapturer g_capturer;

CaptureStatus CaptureD3D9(void* target, LONGLONG presentCount, bool pipeline, PipeWriter* pipe,
                          CaptureStats* stats, const char** errWhy, HRESULT* errHr) {
    return g_capturer.Capture(kOps, target, presentCount, pipeline, pipe, stats, errWhy, errHr);
}

void FlushD3D9(PipeWriter* pipe, CaptureStats* stats, const char** errWhy, HRESULT* errHr) {
    g_capturer.Flush(kOps, pipe, stats, errWhy, errHr);
}

}  // namespace

bool InstallFrameSyncD3D9(int stepDiv) {
    if (!Config().FrameSyncEnabled()) return false;
    audio::dsound_mixer::Install();

    present::capture::Backend backend;
    backend.capture = &CaptureD3D9;
    backend.flush = &FlushD3D9;

    virtual_clock::Options clockOpt;
    clockOpt.stepDiv = stepDiv;
    clockOpt.trackThreads = true;
    clockOpt.hookWaitableTimers = false;
    clockOpt.silentInit = false;

    if (!frame_sync::Install(backend, clockOpt, "D3D9")) return false;
    present::InstallD3D9();
    return true;
}

}  // namespace autoplay
