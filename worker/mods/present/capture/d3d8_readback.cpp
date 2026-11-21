#include "present/capture/d3d8_readback.h"

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
using present::capture::D3dOps;
using present::capture::D3dSurfaceCapturer;
using present::capture::D3dSurfaceInfo;
using present::capture::PipeWriter;

struct SurfDesc8 {
    DWORD Format, Type, Usage, Pool;
    UINT Size;
    DWORD MultiSampleType;
    UINT Width, Height;
};
struct RasterStatus {
    BOOL InVBlank;
    UINT ScanLine;
};

typedef HRESULT(WINAPI* GetBackBuffer8_t)(void* dev, UINT backBuffer, DWORD type, void** surf);
typedef HRESULT(WINAPI* GetRasterStatus8_t)(void* dev, RasterStatus* status);
typedef HRESULT(WINAPI* CreateImageSurface8_t)(void* dev, UINT w, UINT h, DWORD fmt, void** surf);
typedef HRESULT(WINAPI* CopyRects8_t)(void* dev, void* src, const RECT* rects, UINT cRects,
                                      void* dst, const POINT* pts);
typedef HRESULT(WINAPI* GetDesc8_t)(void* surf, SurfDesc8* d);

GetRasterStatus8_t g_origGetRasterStatus8 = nullptr;

HRESULT WINAPI MyGetRasterStatus8(void* dev, RasterStatus* status) {
    if (!virtual_clock::IsVirtualMode()) {
        return g_origGetRasterStatus8 ? g_origGetRasterStatus8(dev, status) : 0;
    }
    if (status) {
        status->InVBlank = TRUE;
        status->ScanLine = 0;
    }
    return 0;
}

void HookRasterStatus(void* dev) {
    if (vtable::HookObject(dev, 17, &MyGetRasterStatus8, &g_origGetRasterStatus8)) {
        Log("FrameSync: hooked GetRasterStatus8 (vtable[17])");
    }
}

HRESULT AcquireBackBuffer(void* dev, void** outBb, D3dSurfaceInfo* outInfo) {
    void** vt = vtable::Of(dev);
    HRESULT hr = ((GetBackBuffer8_t)vt[16])(dev, 0, 0 /*MONO*/, outBb);
    if (FAILED(hr) || !*outBb) return hr;
    SurfDesc8 d = {};
    ((GetDesc8_t)vtable::Of(*outBb)[8])(*outBb, &d);
    *outInfo = {d.Width, d.Height, d.Format, d.MultiSampleType};
    return hr;
}

HRESULT CreateSysSurface(void* dev, UINT w, UINT h, DWORD fmt, void** outSurf) {
    return ((CreateImageSurface8_t)vtable::Of(dev)[27])(dev, w, h, fmt, outSurf);
}

HRESULT CopyToSysSurface(void* dev, void* bb, void* surf) {
    return ((CopyRects8_t)vtable::Of(dev)[28])(dev, bb, nullptr, 0, surf, nullptr);
}

const D3dOps kOps = {
    "CreateImageSurface failed",
    "CopyRects failed",
    /*lockIdx=*/9,
    /*unlockIdx=*/10,
    &HookRasterStatus,
    &AcquireBackBuffer,
    &CreateSysSurface,
    &CopyToSysSurface,
};
D3dSurfaceCapturer g_capturer;

CaptureStatus CaptureD3D8(void* target, LONGLONG presentCount, bool pipeline, PipeWriter* pipe,
                          CaptureStats* stats, const char** errWhy, HRESULT* errHr) {
    return g_capturer.Capture(kOps, target, presentCount, pipeline, pipe, stats, errWhy, errHr);
}

void FlushD3D8(PipeWriter* pipe, CaptureStats* stats, const char** errWhy, HRESULT* errHr) {
    g_capturer.Flush(kOps, pipe, stats, errWhy, errHr);
}

}  // namespace

bool InstallFrameSyncD3D8(int stepDiv) {
    if (!Config().FrameSyncEnabled()) return false;
    audio::dsound_mixer::Install();

    present::capture::Backend backend;
    backend.capture = &CaptureD3D8;
    backend.flush = &FlushD3D8;

    virtual_clock::Options clockOpt;
    clockOpt.stepDiv = stepDiv;
    clockOpt.trackThreads = true;
    clockOpt.hookWaitableTimers = false;
    clockOpt.silentInit = false;

    if (!frame_sync::Install(backend, clockOpt, "D3D8")) return false;
    present::InstallD3D8();
    return true;
}

}  // namespace autoplay
