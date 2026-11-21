// フェーズ94: NvFBC(ToCUDA) → CUDA → NVENC(h264_nvenc) で画面を録画する。映像がシステムメモリを経由しない。
// 録画パイプラインでは x11grab + h264_nvenc の ffmpeg の代わりに起動する(scripts/94_nvfbc/ffmpeg_variant_append.py)。
// ffmpegと合わせている点:
//  - 出力mp4のstart_timeは絶対epoch秒(-copyts相当、mux時のA/V補正が使う)
//  - エンコーダ設定(p4, vbr, cq 23, 5M/6M, framerate=1000000/1)
//  - SIGINTで止まりmp4を完結させる
//  - サイドストリーム(8fpsのJPEG。終了検知用)。ここだけは8fpsでシステムメモリへ下ろす
// ffmpegと違う点: 新しいフレームが来たときだけエンコードする(静止中は間が空く可変フレームレート)。
//
// Build(ホスト): gcc -O2 -o nvfbc_rec nvfbc_rec.c -lavformat -lavcodec -lavutil -lswscale -ldl -lpthread
// Usage: nvfbc_rec <display> <x> <y> <w> <h> <output.mp4> <side_stream.jpg|-> [sampling_ms] [push|timer] [nv12|bgra]
#include <dlfcn.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/hwcontext.h>
#include <ffnvcodec/dynlink_loader.h>  // hwcontext_cuda.hより先(CUDA_VERSIONを定義する)
#include <libavutil/hwcontext_cuda.h>
#include <libavutil/opt.h>
#include <libswscale/swscale.h>
#include "NvFBC.h"

#define SIDE_STREAM_FPS 8.0
#define GRAB_TIMEOUT_MS 100

static volatile sig_atomic_t g_stop = 0;
static void on_signal(int s) { (void)s; g_stop = 1; }

static double realtime(void) {
    struct timespec t;
    clock_gettime(CLOCK_REALTIME, &t);
    return t.tv_sec + t.tv_nsec * 1e-9;
}

// ---- サイドストリーム(別スレッドでJPEG化する) ----
static struct {
    pthread_mutex_t mu;
    pthread_cond_t cv;
    int pending, quit;
    uint8_t *nv12;
    int w, h, bgra, size;
    const char *path;
} g_side = {.mu = PTHREAD_MUTEX_INITIALIZER, .cv = PTHREAD_COND_INITIALIZER};

static void *side_thread(void *arg) {
    (void)arg;
    int w = g_side.w, h = g_side.h;
    uint8_t *copy = malloc(g_side.size);
    const AVCodec *codec = avcodec_find_encoder(AV_CODEC_ID_MJPEG);
    AVCodecContext *c = avcodec_alloc_context3(codec);
    c->width = w; c->height = h; c->pix_fmt = AV_PIX_FMT_YUVJ444P; c->time_base = (AVRational){1, 8};
    c->flags |= AV_CODEC_FLAG_QSCALE; c->global_quality = FF_QP2LAMBDA * 5;
    if (avcodec_open2(c, codec, NULL) < 0) { fprintf(stderr, "mjpeg open failed\n"); return NULL; }
    AVFrame *f = av_frame_alloc();
    f->format = c->pix_fmt; f->width = w; f->height = h; f->quality = c->global_quality;
    av_frame_get_buffer(f, 0);
    AVPacket *pkt = av_packet_alloc();
    // NvFBCのNV12はBT.709のリミテッドレンジ。JPEGはBT.601のフルレンジ
    struct SwsContext *sws = sws_getContext(w, h, g_side.bgra ? AV_PIX_FMT_BGR0 : AV_PIX_FMT_NV12, w, h, AV_PIX_FMT_YUVJ444P, SWS_BILINEAR, NULL, NULL, NULL);
    if (!g_side.bgra) sws_setColorspaceDetails(sws, sws_getCoefficients(SWS_CS_ITU709), 0, sws_getCoefficients(SWS_CS_ITU601), 1, 0, 1 << 16, 1 << 16);
    char tmp[4096];
    snprintf(tmp, sizeof tmp, "%s.tmp", g_side.path);
    int64_t n = 0;
    for (;;) {
        pthread_mutex_lock(&g_side.mu);
        while (!g_side.pending && !g_side.quit) pthread_cond_wait(&g_side.cv, &g_side.mu);
        if (g_side.quit) { pthread_mutex_unlock(&g_side.mu); break; }
        memcpy(copy, g_side.nv12, g_side.size);
        g_side.pending = 0;
        pthread_mutex_unlock(&g_side.mu);
        const uint8_t *src[2] = {copy, copy + w * h};
        int stride[2] = {g_side.bgra ? w * 4 : w, w};
        sws_scale(sws, src, stride, 0, h, f->data, f->linesize);
        f->pts = n++;
        avcodec_send_frame(c, f);
        while (avcodec_receive_packet(c, pkt) == 0) {
            FILE *fp = fopen(tmp, "wb");
            if (fp) { fwrite(pkt->data, 1, pkt->size, fp); fclose(fp); rename(tmp, g_side.path); }
            av_packet_unref(pkt);
        }
    }
    return NULL;
}

#define FBC_CHECK(call) do { NVFBCSTATUS st_ = (call); if (st_ != NVFBC_SUCCESS) { \
    fprintf(stderr, "%s failed: %d: %s\n", #call, st_, fbc.nvFBCGetLastErrorStr(fbc_h)); return 1; } } while (0)
#define AV_CHECK(call) do { int r_ = (call); if (r_ < 0) { char e_[128]; av_strerror(r_, e_, sizeof e_); \
    fprintf(stderr, "%s failed: %s\n", #call, e_); return 1; } } while (0)
#define CU_CHECK(call) do { CUresult r_ = (call); if (r_ != CUDA_SUCCESS) { \
    fprintf(stderr, "%s failed: %d\n", #call, r_); return 1; } } while (0)

static int drain(AVCodecContext *enc, AVFormatContext *oc, AVStream *st, AVPacket *pkt) {
    int r;
    while ((r = avcodec_receive_packet(enc, pkt)) == 0) {
        av_packet_rescale_ts(pkt, enc->time_base, st->time_base);
        pkt->stream_index = st->index;
        r = av_interleaved_write_frame(oc, pkt);
        if (r < 0) return r;
    }
    return (r == AVERROR(EAGAIN) || r == AVERROR_EOF) ? 0 : r;
}

int main(int argc, char **argv) {
    if (argc < 8) { fprintf(stderr, "usage: see source\n"); return 2; }
    setenv("DISPLAY", argv[1], 1);
    int x = atoi(argv[2]), y = atoi(argv[3]), w = atoi(argv[4]), h = atoi(argv[5]);
    const char *output = argv[6], *side = argv[7];
    int sampling_ms = argc > 8 ? atoi(argv[8]) : 1;
    int push = !(argc > 9 && !strcmp(argv[9], "timer"));
    int use_bgra = argc > 10 && !strcmp(argv[10], "bgra");
    setvbuf(stdout, NULL, _IOLBF, 0);
    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    // CUDAデバイス(hwcontextが作ったコンテキストをNvFBCと共有する)
    CudaFunctions *cu = NULL;
    if (cuda_load_functions(&cu, NULL) < 0) { fprintf(stderr, "cuda_load_functions failed\n"); return 1; }
    AVBufferRef *dev_ref = NULL;
    AV_CHECK(av_hwdevice_ctx_create(&dev_ref, AV_HWDEVICE_TYPE_CUDA, NULL, NULL, 0));
    AVCUDADeviceContext *cu_dev = ((AVHWDeviceContext *)dev_ref->data)->hwctx;
    CU_CHECK(cu->cuCtxPushCurrent(cu_dev->cuda_ctx));

    // NvFBC
    void *lib = dlopen("libnvidia-fbc.so.1", RTLD_NOW);
    if (!lib) { fprintf(stderr, "dlopen: %s\n", dlerror()); return 1; }
    PNVFBCCREATEINSTANCE create = (PNVFBCCREATEINSTANCE)dlsym(lib, "NvFBCCreateInstance");
    NVFBC_API_FUNCTION_LIST fbc; memset(&fbc, 0, sizeof fbc); fbc.dwVersion = NVFBC_VERSION;
    if (create(&fbc) != NVFBC_SUCCESS) { fprintf(stderr, "NvFBCCreateInstance failed\n"); return 1; }
    NVFBC_SESSION_HANDLE fbc_h = 0;
    NVFBC_CREATE_HANDLE_PARAMS cp; memset(&cp, 0, sizeof cp); cp.dwVersion = NVFBC_CREATE_HANDLE_PARAMS_VER;
    FBC_CHECK(fbc.nvFBCCreateHandle(&fbc_h, &cp));
    NVFBC_CREATE_CAPTURE_SESSION_PARAMS cs; memset(&cs, 0, sizeof cs);
    cs.dwVersion = NVFBC_CREATE_CAPTURE_SESSION_PARAMS_VER;
    cs.eCaptureType = NVFBC_CAPTURE_SHARED_CUDA;
    cs.eTrackingType = NVFBC_TRACKING_SCREEN;
    cs.captureBox.x = x; cs.captureBox.y = y;
    cs.captureBox.w = w; cs.captureBox.h = h;
    cs.frameSize.w = w; cs.frameSize.h = h;
    cs.bWithCursor = NVFBC_FALSE;
    cs.bDisableAutoModesetRecovery = NVFBC_TRUE;
    cs.dwSamplingRateMs = sampling_ms;
    cs.bPushModel = push ? NVFBC_TRUE : NVFBC_FALSE;
    NVFBC_TOCUDA_SETUP_PARAMS sp; memset(&sp, 0, sizeof sp);
    sp.dwVersion = NVFBC_TOCUDA_SETUP_PARAMS_VER; sp.eBufferFormat = use_bgra ? NVFBC_BUFFER_FORMAT_BGRA : NVFBC_BUFFER_FORMAT_NV12;
    FBC_CHECK(fbc.nvFBCCreateCaptureSession(fbc_h, &cs));
    FBC_CHECK(fbc.nvFBCToCudaSetUp(fbc_h, &sp));

    // エンコーダ
    AVBufferRef *frames_ref = av_hwframe_ctx_alloc(dev_ref);
    AVHWFramesContext *fc = (AVHWFramesContext *)frames_ref->data;
    fc->format = AV_PIX_FMT_CUDA; fc->sw_format = use_bgra ? AV_PIX_FMT_BGR0 : AV_PIX_FMT_NV12; fc->width = w; fc->height = h;
    AV_CHECK(av_hwframe_ctx_init(frames_ref));
    const AVCodec *codec = avcodec_find_encoder_by_name("h264_nvenc");
    if (!codec) { fprintf(stderr, "h264_nvenc not found\n"); return 1; }
    AVCodecContext *enc = avcodec_alloc_context3(codec);
    enc->width = w; enc->height = h; enc->pix_fmt = AV_PIX_FMT_CUDA;
    enc->hw_frames_ctx = av_buffer_ref(frames_ref);
    enc->time_base = (AVRational){1, 1000000}; enc->framerate = (AVRational){1000000, 1};
    enc->bit_rate = 5000000; enc->rc_max_rate = 6000000;
    enc->max_b_frames = 0;  // 可変フレームレートのptsではNVENCのdts計算がpts<dtsになり、muxが失敗する
    enc->colorspace = AVCOL_SPC_BT709; enc->color_primaries = AVCOL_PRI_BT709;
    enc->color_trc = AVCOL_TRC_BT709; enc->color_range = AVCOL_RANGE_MPEG;
    enc->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    av_opt_set(enc->priv_data, "preset", "p4", 0);
    av_opt_set(enc->priv_data, "rc", "vbr", 0);
    av_opt_set_double(enc->priv_data, "cq", 23, 0);
    AV_CHECK(avcodec_open2(enc, codec, NULL));

    // mux
    AVFormatContext *oc = NULL;
    AV_CHECK(avformat_alloc_output_context2(&oc, NULL, NULL, output));
    AVStream *st = avformat_new_stream(oc, NULL);
    AV_CHECK(avcodec_parameters_from_context(st->codecpar, enc));
    st->time_base = (AVRational){1, 1000000};
    oc->avoid_negative_ts = AVFMT_AVOID_NEG_TS_DISABLED;
    AV_CHECK(avio_open(&oc->pb, output, AVIO_FLAG_WRITE));
    AV_CHECK(avformat_write_header(oc, NULL));

    // サイドストリーム
    pthread_t side_tid; int has_side = strcmp(side, "-") != 0;
    if (has_side) {
        g_side.w = w; g_side.h = h; g_side.path = side; g_side.bgra = use_bgra;
        g_side.size = use_bgra ? w * h * 4 : w * h * 3 / 2; g_side.nv12 = malloc(g_side.size);
        pthread_create(&side_tid, NULL, side_thread, NULL);
    }
    uint8_t *side_buf = has_side ? malloc(g_side.size) : NULL;

    AVFrame *frame = av_frame_alloc();
    AVPacket *pkt = av_packet_alloc();
    long long encoded = 0, grabs = 0, missed = 0, last_encoded = 0, recreated = 0;
    int64_t last_pts = -1;
    double next_side = 0, next_log = realtime() + 5, last_log = realtime();
    double t_grab = 0, t_copy = 0, t_enc = 0;
    int first = 1;
    while (!g_stop) {
        NVFBC_FRAME_GRAB_INFO info; memset(&info, 0, sizeof info);
        unsigned long long dev_buf = 0;
        NVFBC_TOCUDA_GRAB_FRAME_PARAMS g; memset(&g, 0, sizeof g);
        g.dwVersion = NVFBC_TOCUDA_GRAB_FRAME_PARAMS_VER;
        g.dwFlags = NVFBC_TOCUDA_GRAB_FLAGS_NOWAIT_IF_NEW_FRAME_READY;
        if (first) g.dwFlags = NVFBC_TOCUDA_GRAB_FLAGS_NOWAIT | NVFBC_TOCUDA_GRAB_FLAGS_FORCE_REFRESH;
        g.pCUDADeviceBuffer = &dev_buf; g.pFrameGrabInfo = &info; g.dwTimeoutMs = GRAB_TIMEOUT_MS;
        double t0 = realtime();
        NVFBCSTATUS s = fbc.nvFBCToCudaGrabFrame(fbc_h, &g);
        double t1 = realtime();
        t_grab += t1 - t0;
        if (s == NVFBC_ERR_MUST_RECREATE) {
            // Lunaticの録画中(約10分後)に実際に発生した(reports/94)。録画を止めずセッションだけ作り直す
            printf("session lost at frame=%lld, recreating: %s\n", encoded, fbc.nvFBCGetLastErrorStr(fbc_h));
            recreated++;
            NVFBC_DESTROY_CAPTURE_SESSION_PARAMS d; memset(&d, 0, sizeof d);
            d.dwVersion = NVFBC_DESTROY_CAPTURE_SESSION_PARAMS_VER;
            fbc.nvFBCDestroyCaptureSession(fbc_h, &d);
            FBC_CHECK(fbc.nvFBCCreateCaptureSession(fbc_h, &cs));
            FBC_CHECK(fbc.nvFBCToCudaSetUp(fbc_h, &sp));
            continue;
        }
        if (s != NVFBC_SUCCESS) { fprintf(stderr, "grab failed: %d: %s\n", s, fbc.nvFBCGetLastErrorStr(fbc_h)); break; }
        grabs++;
        if (first) printf("first grab: %ux%u bytes=%u dev=%llx postproc=%d\n", info.dwWidth, info.dwHeight, info.dwByteSize, dev_buf, info.bRequiredPostProcessing);
        missed += info.dwMissedFrames;

        // サイドストリーム。静止中(新フレームが無い)も更新する。終了検知は静止を見るため
        if (has_side && t1 >= next_side) {
            CUDA_MEMCPY2D m; memset(&m, 0, sizeof m);
            m.srcMemoryType = CU_MEMORYTYPE_DEVICE; m.srcDevice = dev_buf; m.srcPitch = use_bgra ? w * 4 : w;
            m.dstMemoryType = CU_MEMORYTYPE_HOST; m.dstHost = side_buf; m.dstPitch = m.srcPitch;
            m.WidthInBytes = m.srcPitch; m.Height = use_bgra ? h : h + h / 2;
            CU_CHECK(cu->cuMemcpy2D(&m));
            pthread_mutex_lock(&g_side.mu);
            memcpy(g_side.nv12, side_buf, g_side.size);
            g_side.pending = 1;
            pthread_cond_signal(&g_side.cv);
            pthread_mutex_unlock(&g_side.mu);
            next_side = t1 + 1.0 / SIDE_STREAM_FPS;
        }

        if (info.bIsNewFrame || first) {
            double t2 = realtime();
            av_frame_unref(frame);
            AV_CHECK(av_hwframe_get_buffer(frames_ref, frame, 0));
            // NvFBCのバッファは次のgrabで上書きされるので、NVENCの非同期処理のためGPU上でコピーする
            CUDA_MEMCPY2D m; memset(&m, 0, sizeof m);
            m.srcMemoryType = CU_MEMORYTYPE_DEVICE; m.srcDevice = dev_buf; m.srcPitch = use_bgra ? w * 4 : w;
            m.dstMemoryType = CU_MEMORYTYPE_DEVICE; m.dstDevice = (CUdeviceptr)frame->data[0]; m.dstPitch = frame->linesize[0];
            m.WidthInBytes = m.srcPitch; m.Height = h;
            CU_CHECK(cu->cuMemcpy2D(&m));
            if (!use_bgra) {
                m.srcDevice = dev_buf + (unsigned long long)w * h;
                m.dstDevice = (CUdeviceptr)frame->data[1]; m.dstPitch = frame->linesize[1];
                m.Height = h / 2;
                CU_CHECK(cu->cuMemcpy2D(&m));
            }
            double t3 = realtime();
            t_copy += t3 - t2;
            int64_t pts = (int64_t)(t1 * 1e6);
            if (pts <= last_pts) pts = last_pts + 1;
            last_pts = pts;
            frame->pts = pts;
            AV_CHECK(avcodec_send_frame(enc, frame));
            AV_CHECK(drain(enc, oc, st, pkt));
            t_enc += realtime() - t3;
            encoded++;
            first = 0;
        }

        double now = realtime();
        if (now >= next_log) {
            double el = now - last_log;
            printf("frame=%lld fps=%.1f missed=%lld grab=%.1fms copy=%.2fms enc=%.2fms\n",
                   encoded, (encoded - last_encoded) / el,
                   missed, 1000 * t_grab / (encoded - last_encoded + 1), 1000 * t_copy / (encoded - last_encoded + 1), 1000 * t_enc / (encoded - last_encoded + 1));
            last_encoded = encoded; last_log = now; next_log = now + 5; t_grab = t_copy = t_enc = 0;
        }
    }

    avcodec_send_frame(enc, NULL);
    drain(enc, oc, st, pkt);
    av_write_trailer(oc);
    avio_closep(&oc->pb);
    if (has_side) {
        pthread_mutex_lock(&g_side.mu); g_side.quit = 1; pthread_cond_signal(&g_side.cv); pthread_mutex_unlock(&g_side.mu);
        pthread_join(side_tid, NULL);
    }
    printf("done: encoded=%lld grabs=%lld missed=%lld recreated=%lld\n", encoded, grabs, missed, recreated);
    fflush(NULL);
    // ドライバの後始末(atexit)がSIGINT後に戻らず、pipelineの20秒待ちを超えることがあった。mp4は完結済みなので即終了する
    _exit(0);
}
