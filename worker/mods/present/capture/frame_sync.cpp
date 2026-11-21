#include "present/capture/frame_sync.h"

#include "clock/virtual_clock.h"
#include "clock/virtual_clock_math.h"
#include "core/log.h"
#include "core/log_contract.h"
#include "core/runtime_config.h"
#include "core/time_scale.h"
#include "present/bus.h"
#include "present/capture/pipe_writer.h"
#include "present/limiter.h"

namespace autoplay::frame_sync {

namespace {

constexpr int kStatsEvery = 600;

bool g_active = false;
bool g_captureDone = false;
bool g_loggedInitSummary = false;
const char* g_backendName = "";
int g_effectiveStepDiv = 1024;
volatile LONG g_unthrottled = 0;

present::capture::Backend g_backend;
present::capture::PipeWriter g_pipe;
AudioHooks g_audio;

LONGLONG g_presentCount = 0;
volatile LONG g_presentCount32 = 0;
LONGLONG g_framesWritten = 0;
LONGLONG g_framesThrottledForThreads = 0;

LONGLONG g_statReadback = 0;
LONGLONG g_statWrite = 0;
LONGLONG g_statPresent = 0;
LONGLONG g_statGame = 0;
LONGLONG g_statAudio = 0;
LONGLONG g_statWindowStart = 0;
LONGLONG g_statWindowStartFrame = 0;
LONGLONG g_prePresentEnd = 0;
LONGLONG g_postPresentEnd = 0;

void CloseAudio() {
    if (g_audio.close) g_audio.close();
}

void GiveUpCapture(const char* why, HRESULT hr) {
    Log("FrameSync: ERROR %s (hr=0x%08lX)。取り込みを中止します", why, (unsigned long)hr);
    g_pipe.Close();
    g_captureDone = true;
    InterlockedExchange(&g_unthrottled, 0);
    CloseAudio();
}

void AccumulateStats(const present::capture::CaptureStats& stats) {
    g_statReadback += stats.readbackTicks;
    g_statWrite += stats.writeTicks;
    if (stats.wroteFrame) g_framesWritten++;
}

void StopCapture() {
    if (g_backend.flush) {
        present::capture::CaptureStats flushStats = {};
        const char* errWhy = nullptr;
        HRESULT errHr = S_OK;
        g_backend.flush(&g_pipe, &flushStats, &errWhy, &errHr);
        AccumulateStats(flushStats);
        if (errWhy) {
            GiveUpCapture(errWhy, errHr);
            return;
        }
    }
    g_pipe.Close();
    g_captureDone = true;
    InterlockedExchange(&g_unthrottled, 0);
    Log(log_contract::kFrameSyncCaptureStoppedFmt, g_framesWritten, g_presentCount,
        g_framesThrottledForThreads, Config().frameSyncThrottleWhileThreads ? 1 : 0);
    CloseAudio();
}

void LogInitSummary() {
    const RuntimeConfig& c = Config();
    Log("InstallFrameSyncHook (%s): step_div=%d pipeline=%d skip_present=%d "
        "throttle_while_threads=%d pipe=%s",
        g_backendName, g_effectiveStepDiv, c.frameSyncPipeline ? 1 : 0,
        c.frameSyncSkipPresent ? 1 : 0, c.frameSyncThrottleWhileThreads ? 1 : 0, c.frameSyncPipe);
}

void OnPrePresent(const present::Frame& frame, unsigned& flags) {
    LONGLONG entry = virtual_clock::RealNow();
    if (!g_loggedInitSummary) {
        g_loggedInitSummary = true;
        LogInitSummary();
    }
    if (!virtual_clock::IsVirtualMode()) {
        virtual_clock::Enter();
        g_statWindowStart = entry;
    }
    if (g_postPresentEnd) g_statGame += entry - g_postPresentEnd;
    g_presentCount++;
    InterlockedIncrement(&g_presentCount32);

    bool captured = false;
    const RuntimeConfig& cfg = Config();
    if (!g_captureDone) {
        if (!g_pipe.IsOpen() && !g_pipe.Open(cfg.frameSyncPipe)) {
            GiveUpCapture("cannot open FRAME_SYNC_PIPE", (HRESULT)g_pipe.LastError());
        }
        if (g_pipe.IsOpen()) {
            if (cfg.frameSyncStop[0] && (g_presentCount & 7) == 0 &&
                GetFileAttributesA(cfg.frameSyncStop) != INVALID_FILE_ATTRIBUTES) {
                StopCapture();
            } else {
                present::capture::CaptureStats stats = {};
                const char* errWhy = nullptr;
                HRESULT errHr = S_OK;
                auto status = g_backend.capture(frame.target, g_presentCount, cfg.frameSyncPipeline,
                                                &g_pipe, &stats, &errWhy, &errHr);
                AccumulateStats(stats);
                if (status == present::capture::CaptureStatus::kError) {
                    GiveUpCapture(errWhy ? errWhy : "capture failed", errHr);
                }
                captured = !g_captureDone;
            }
        }
    }

    if (g_audio.mixFrame) {
        LONGLONG a0 = virtual_clock::RealNow();
        g_audio.mixFrame(captured);
        g_statAudio += virtual_clock::RealNow() - a0;
    }

    if (g_presentCount - g_statWindowStartFrame >= kStatsEvery) {
        LONGLONG now = virtual_clock::RealNow();
        LONGLONG freq = virtual_clock::Freq();
        double n = (double)(g_presentCount - g_statWindowStartFrame);
        double toMs = freq > 0 ? 1000.0 / (double)freq : 0.0;
        double realMs = (double)(now - g_statWindowStart) * toMs;
        double fps = realMs > 0.0 ? n * 1000.0 / realMs : 0.0;
        Log("FrameSync: stats frame=%lld written=%lld real_ms=%.0f fps=%.1f "
            "game_ms=%.3f readback_ms=%.3f write_ms=%.3f present_ms=%.3f unthrottled=%ld "
            "readback2_ms=0.000 audio_ms=%.3f",
            g_presentCount, g_framesWritten, realMs, fps, (double)g_statGame * toMs / n,
            (double)g_statReadback * toMs / n, (double)g_statWrite * toMs / n,
            (double)g_statPresent * toMs / n, (long)g_unthrottled,
            (double)g_statAudio * toMs / n);
        g_statGame = g_statReadback = g_statWrite = g_statPresent = g_statAudio = 0;
        g_statWindowStart = now;
        g_statWindowStartFrame = g_presentCount;
    }

    virtual_clock::RecordPresentFrame(g_presentCount);
    bool loading = virtual_clock::CountLiveThreads() > 0;
    if (loading && g_unthrottled) g_framesThrottledForThreads++;

    g_prePresentEnd = virtual_clock::RealNow();
    if (!g_unthrottled || (loading && cfg.frameSyncThrottleWhileThreads)) {
        flags |= present::kThrottle;
        return;
    }
    flags &= ~present::kThrottle;
    if (frame.syncInterval) *frame.syncInterval = 0;
    if (cfg.frameSyncSkipPresent) flags |= present::kSkip;
}

void OnPostPresent(const present::Frame&, unsigned, HRESULT) {
    if (virtual_clock::IsVirtualMode()) virtual_clock::AdvanceToFrame(g_presentCount);
    g_postPresentEnd = virtual_clock::RealNow();
    g_statPresent += g_postPresentEnd - g_prePresentEnd;
}

void OnResize(present::Api, void* target, UINT width, UINT height, DWORD format) {
    if (!g_backend.onResize) return;
    present::capture::CaptureStats stats = {};
    const char* errWhy = nullptr;
    HRESULT errHr = S_OK;
    g_backend.onResize(target, width, height, format, &g_pipe, &stats, &errWhy, &errHr);
    AccumulateStats(stats);
    if (errWhy) GiveUpCapture(errWhy, errHr);
}

}  // namespace

void SetAudioHooks(const AudioHooks& hooks) { g_audio = hooks; }

bool Install(const present::capture::Backend& backend,
             const virtual_clock::Options& clockOptions, const char* backendName) {
    if (!Config().FrameSyncEnabled()) return false;
    if (g_active) return true;

    g_backend = backend;
    g_backendName = backendName ? backendName : "";
    g_effectiveStepDiv = Config().FrameSyncStepDivOr(clockOptions.stepDiv);

    virtual_clock::Install(clockOptions);
    time_scale::SetMenuSleepHandler(&SleepMs);

    present::AddPreHandler(&OnPrePresent, present::kPriorityFrameSync);
    present::AddPostHandler(&OnPostPresent, present::kPriorityFrameSync);
    if (g_backend.onResize) present::AddResizeHandler(&OnResize);
    InstallFpsLimiterHandlers();

    g_active = true;
    if (!clockOptions.silentInit) {
        g_loggedInitSummary = true;
        LogInitSummary();
    }
    return true;
}

bool Active() { return g_active; }

void SetUnthrottled(bool unthrottled) {
    if (!g_active) return;
    if (unthrottled && g_captureDone) return;
    InterlockedExchange(&g_unthrottled, unthrottled ? 1 : 0);
    Log(log_contract::kFrameSyncUnthrottledFmt, unthrottled ? 1 : 0, g_presentCount);
}

void SleepMs(unsigned long ms) {
    if (!g_active) {
        Sleep(ms);
        return;
    }
    const DWORD kTimeoutMs = 300000;
    LONGLONG targetFrames = virtual_clock::FramesForSleepMs(ms);
    LONG startFrame = InterlockedCompareExchange(&g_presentCount32, 0, 0);
    DWORD realStart = GetTickCount();
    while ((LONGLONG)(InterlockedCompareExchange(&g_presentCount32, 0, 0) - startFrame) <
           targetFrames) {
        if (GetTickCount() - realStart >= kTimeoutMs) {
            Log("FrameSyncSleepMs: TIMEOUT waiting %lld frames (ms=%lu)", targetFrames, ms);
            return;
        }
        Sleep(2);
    }
    while (virtual_clock::CountLiveThreads() > 0) {
        if (GetTickCount() - realStart >= kTimeoutMs) {
            Log("FrameSyncSleepMs: TIMEOUT waiting live threads (ms=%lu)", ms);
            return;
        }
        Sleep(10);
    }
}

void WaitPresentFrames(int frames) {
    if (!g_active || frames <= 0) return;
    const DWORD kTimeoutMs = 300000;
    LONG startFrame = InterlockedCompareExchange(&g_presentCount32, 0, 0);
    DWORD realStart = GetTickCount();
    while ((InterlockedCompareExchange(&g_presentCount32, 0, 0) - startFrame) < frames) {
        if (GetTickCount() - realStart >= kTimeoutMs) {
            Log("FrameSyncWaitPresentFrames: TIMEOUT waiting %d frames", frames);
            return;
        }
        Sleep(2);
    }
}

}  // namespace autoplay::frame_sync
