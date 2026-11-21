// フェーズ94: NvFBCがvGPU(g6f)で使えるか、何fpsで取れるかを調べるプローブ。
// NvFBC.hはNVIDIA配布のヘッダ(gpu-screen-recorderのexternal/NvFBC.hを取得して使う、リポジトリには入れない)。
//
// Build: gcc -O2 -o nvfbc_probe nvfbc_probe.c -ldl
// Usage: DISPLAY=:N ./nvfbc_probe <sys|cuda> <秒数> <x> <y> <w> <h> [sampling_ms] [push]
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "NvFBC.h"

typedef int (*cu_init_t)(unsigned);
typedef int (*cu_device_get_t)(int *, int);
typedef int (*cu_ctx_create_t)(void **, unsigned, int);

static double now(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec + t.tv_nsec * 1e-9;
}

#define CHECK(call) do { NVFBCSTATUS st_ = (call); if (st_ != NVFBC_SUCCESS) { \
    fprintf(stderr, "%s failed: %d: %s\n", #call, st_, fbc.nvFBCGetLastErrorStr(h)); return 1; } } while (0)

int main(int argc, char **argv) {
    if (argc < 7) { fprintf(stderr, "usage\n"); return 2; }
    int use_cuda = !strcmp(argv[1], "cuda");
    double seconds = atof(argv[2]);
    void *lib = dlopen("libnvidia-fbc.so.1", RTLD_NOW);
    if (!lib) { fprintf(stderr, "dlopen: %s\n", dlerror()); return 1; }
    PNVFBCCREATEINSTANCE create = (PNVFBCCREATEINSTANCE)dlsym(lib, "NvFBCCreateInstance");
    NVFBC_API_FUNCTION_LIST fbc; memset(&fbc, 0, sizeof fbc); fbc.dwVersion = NVFBC_VERSION;
    NVFBCSTATUS st = create(&fbc);
    if (st != NVFBC_SUCCESS) { fprintf(stderr, "NvFBCCreateInstance: %d\n", st); return 1; }

    NVFBC_SESSION_HANDLE h = 0;
    NVFBC_CREATE_HANDLE_PARAMS cp; memset(&cp, 0, sizeof cp); cp.dwVersion = NVFBC_CREATE_HANDLE_PARAMS_VER;
    st = fbc.nvFBCCreateHandle(&h, &cp);
    if (st != NVFBC_SUCCESS) { fprintf(stderr, "CreateHandle: %d: %s\n", st, fbc.nvFBCGetLastErrorStr(h)); return 1; }

    NVFBC_GET_STATUS_PARAMS gs; memset(&gs, 0, sizeof gs); gs.dwVersion = NVFBC_GET_STATUS_PARAMS_VER;
    CHECK(fbc.nvFBCGetStatus(h, &gs));
    printf("status: isCapturePossible=%d currentlyCapturing=%d canCreateNow=%d screen=%ux%u xrandr=%d outputs=%u nvfbcVer=%x\n",
           gs.bIsCapturePossible, gs.bCurrentlyCapturing, gs.bCanCreateNow, gs.screenSize.w, gs.screenSize.h,
           gs.bXRandRAvailable, gs.dwOutputNum, gs.dwNvFBCVersion);
    for (unsigned i = 0; i < gs.dwOutputNum; i++)
        printf("output %u id=%u name=%s tracked=%ux%u+%u+%u\n", i, gs.outputs[i].dwId, gs.outputs[i].name,
               gs.outputs[i].trackedBox.w, gs.outputs[i].trackedBox.h, gs.outputs[i].trackedBox.x, gs.outputs[i].trackedBox.y);

    void *cu_ctx = NULL;
    if (use_cuda) {
        void *cu = dlopen("libcuda.so.1", RTLD_NOW);
        if (!cu) { fprintf(stderr, "dlopen cuda: %s\n", dlerror()); return 1; }
        int dev = 0;
        ((cu_init_t)dlsym(cu, "cuInit"))(0);
        ((cu_device_get_t)dlsym(cu, "cuDeviceGet"))(&dev, 0);
        int r = ((cu_ctx_create_t)dlsym(cu, "cuCtxCreate_v2"))(&cu_ctx, 0, dev);
        printf("cuCtxCreate: %d\n", r);
        if (r) return 1;
    }

    NVFBC_CREATE_CAPTURE_SESSION_PARAMS cs; memset(&cs, 0, sizeof cs);
    cs.dwVersion = NVFBC_CREATE_CAPTURE_SESSION_PARAMS_VER;
    cs.eCaptureType = use_cuda ? NVFBC_CAPTURE_SHARED_CUDA : NVFBC_CAPTURE_TO_SYS;
    cs.eTrackingType = NVFBC_TRACKING_SCREEN;
    cs.captureBox.x = atoi(argv[3]); cs.captureBox.y = atoi(argv[4]);
    cs.captureBox.w = atoi(argv[5]); cs.captureBox.h = atoi(argv[6]);
    cs.frameSize.w = cs.captureBox.w; cs.frameSize.h = cs.captureBox.h;
    cs.bWithCursor = NVFBC_FALSE;
    cs.bDisableAutoModesetRecovery = NVFBC_TRUE;
    cs.dwSamplingRateMs = argc > 7 ? atoi(argv[7]) : 1;
    cs.bPushModel = (argc > 8 && !strcmp(argv[8], "push")) ? NVFBC_TRUE : NVFBC_FALSE;
    CHECK(fbc.nvFBCCreateCaptureSession(h, &cs));

    void *sysbuf = NULL;
    if (use_cuda) {
        NVFBC_TOCUDA_SETUP_PARAMS sp; memset(&sp, 0, sizeof sp);
        sp.dwVersion = NVFBC_TOCUDA_SETUP_PARAMS_VER; sp.eBufferFormat = NVFBC_BUFFER_FORMAT_NV12;
        CHECK(fbc.nvFBCToCudaSetUp(h, &sp));
    } else {
        NVFBC_TOSYS_SETUP_PARAMS sp; memset(&sp, 0, sizeof sp);
        sp.dwVersion = NVFBC_TOSYS_SETUP_PARAMS_VER; sp.eBufferFormat = NVFBC_BUFFER_FORMAT_BGRA; sp.ppBuffer = &sysbuf;
        CHECK(fbc.nvFBCToSysSetUp(h, &sp));
    }

    double t0 = now(), last = t0, max_gap = 0;
    long frames = 0, news = 0; unsigned first = 0, cur = 0;
    while (now() - t0 < seconds) {
        NVFBC_FRAME_GRAB_INFO info; memset(&info, 0, sizeof info);
        if (use_cuda) {
            unsigned long long dev_buf = 0;
            NVFBC_TOCUDA_GRAB_FRAME_PARAMS g; memset(&g, 0, sizeof g);
            g.dwVersion = NVFBC_TOCUDA_GRAB_FRAME_PARAMS_VER; g.dwFlags = NVFBC_TOCUDA_GRAB_FLAGS_NOWAIT_IF_NEW_FRAME_READY;
            g.pCUDADeviceBuffer = &dev_buf; g.pFrameGrabInfo = &info; g.dwTimeoutMs = 1000;
            CHECK(fbc.nvFBCToCudaGrabFrame(h, &g));
        } else {
            NVFBC_TOSYS_GRAB_FRAME_PARAMS g; memset(&g, 0, sizeof g);
            g.dwVersion = NVFBC_TOSYS_GRAB_FRAME_PARAMS_VER; g.dwFlags = NVFBC_TOSYS_GRAB_FLAGS_NOWAIT_IF_NEW_FRAME_READY;
            g.pFrameGrabInfo = &info; g.dwTimeoutMs = 1000;
            CHECK(fbc.nvFBCToSysGrabFrame(h, &g));
        }
        double t = now();
        if (t - last > max_gap) max_gap = t - last;
        last = t;
        if (!frames) first = info.dwCurrentFrame;
        cur = info.dwCurrentFrame;
        frames++;
        if (info.bIsNewFrame) news++;
    }
    double el = now() - t0;
    printf("result: mode=%s grabs=%ld (%.1f/s) new=%ld (%.1f/s) frameid_delta=%u (%.1f/s) max_gap=%.1fms\n",
           argv[1], frames, frames / el, news, news / el, cur - first, (cur - first) / el, max_gap * 1000);
    return 0;
}
