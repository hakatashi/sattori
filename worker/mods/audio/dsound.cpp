#include "audio/dsound.h"
#include "audio/sync_marker.h"
#include "core/log.h"
#include "core/pe_iat.h"
#include "core/runtime_config.h"
#include "core/vtable_hook.h"

namespace autoplay {

// COM interface信頼のため、DirectX SDKヘッダを使わずABI互換な素の型のみで宣言する
// (input/dinput.cppと同じ方針)。

typedef HRESULT(WINAPI* DirectSoundCreate8_t)(const void* pcGuidDevice, void** ppDS8,
                                               void* pUnkOuter);
typedef HRESULT(WINAPI* CreateSoundBuffer_t)(void* pThis, const void* pcDSBufferDesc,
                                              void** ppDSBuffer, void* pUnkOuter);
typedef HRESULT(WINAPI* DuplicateSoundBuffer_t)(void* pThis, void* pDSBufferOriginal,
                                                 void** ppDSBufferDuplicate);
typedef HRESULT(WINAPI* GetFrequency_t)(void* pThis, DWORD* lpdwFrequency);
typedef HRESULT(WINAPI* SetFrequency_t)(void* pThis, DWORD dwFrequency);

static DirectSoundCreate8_t g_origDirectSoundCreate8 = nullptr;
static CreateSoundBuffer_t g_origCreateSoundBuffer = nullptr;
static DuplicateSoundBuffer_t g_origDuplicateSoundBuffer = nullptr;
static SetFrequency_t g_origSetFrequency = nullptr;

static dsound::BufferCreatedCallback g_onBufferCreated = nullptr;
static dsound::BufferDuplicatedCallback g_onBufferDuplicated = nullptr;

static double g_freqScale = 1.0;

// 同期マーカー(フェーズ88)用に、ゲームが作成したIDirectSound8を控えておく。
static void* volatile g_ds8 = nullptr;

static const DWORD kDSBCAPS_PRIMARYBUFFER = 0x00000001;
static const DWORD kDSBCAPS_CTRLFREQUENCY = 0x00000020;

// DSBUFFERDESC(dsound.h)のABI互換な素の型再宣言。
struct DSBufferDescMin {
    DWORD dwSize;
    DWORD dwFlags;
    DWORD dwBufferBytes;
    DWORD dwReserved;
    void* lpwfxFormat;
    GUID guid3DAlgorithm;
};

static HRESULT WINAPI MySetFrequency(void* pThis, DWORD dwFrequency) {
    DWORD scaled = (DWORD)(dwFrequency * g_freqScale + 0.5);
    Log("MySetFrequency: requested=%lu scaled=%lu (freqScale=%.4f)", dwFrequency, scaled,
        g_freqScale);
    return g_origSetFrequency(pThis, scaled);
}

static HRESULT WINAPI MyCreateSoundBuffer(void* pThis, const void* pcDSBufferDesc,
                                           void** ppDSBuffer, void* pUnkOuter) {
    // DSBCAPS_CTRLFREQUENCYが立っていないとSetFrequencyがDSERR_CONTROLUNAVAILで
    // 失敗するため、プライマリバッファでなければローカルコピーでフラグを
    // 強制追加してから元の関数に渡す。
    DSBufferDescMin descCopy = {};
    const void* descToUse = pcDSBufferDesc;
    bool isPrimary = false;
    if (pcDSBufferDesc) {
        const DSBufferDescMin* orig = (const DSBufferDescMin*)pcDSBufferDesc;
        isPrimary = (orig->dwFlags & kDSBCAPS_PRIMARYBUFFER) != 0;
        if (!isPrimary && orig->dwSize >= sizeof(DSBufferDescMin)) {
            descCopy = *orig;
            descCopy.dwFlags |= kDSBCAPS_CTRLFREQUENCY;
            descToUse = &descCopy;
        }
    }

    HRESULT hr = g_origCreateSoundBuffer(pThis, descToUse, ppDSBuffer, pUnkOuter);
    if (SUCCEEDED(hr) && ppDSBuffer && *ppDSBuffer) {
        if (g_onBufferCreated) g_onBufferCreated(*ppDSBuffer, pcDSBufferDesc, isPrimary);
        // プライマリバッファには何もしない。Wineではプライマリのフォーマットを
        // いじっても実際の出力ストリームのレートは変わらない(audio/dsound.h のコメント参照)。
        if (!isPrimary && !Config().FrameSyncEnabled()) {
            void** vt = vtable::Of(*ppDSBuffer);
            // 複数のバッファが同じ静的vtableを共有している(core/vtable_hook.h)。
            if (vtable::Hook(vt, 17, &MySetFrequency, &g_origSetFrequency)) {
                Log("CreateSoundBuffer: hooked SetFrequency (vtable[17])");
            }
            if (g_freqScale != 1.0) {
                // ゲームが一度もSetFrequencyを呼ばない場合に備え、初期周波数にも
                // スケールを適用する(g_origSetFrequency直接呼び出しのためMySetFrequency
                // 経由の二重スケールにはならない)。
                GetFrequency_t getFreq = (GetFrequency_t)vt[8];
                DWORD freq = 0;
                if (SUCCEEDED(getFreq(*ppDSBuffer, &freq)) && freq > 0) {
                    DWORD scaled = (DWORD)(freq * g_freqScale + 0.5);
                    HRESULT setHr = g_origSetFrequency(*ppDSBuffer, scaled);
                    Log("CreateSoundBuffer: initial freq=%lu scaled=%lu setHr=0x%08lX", freq,
                        scaled, (unsigned long)setHr);
                }
            }
        }
    }
    return hr;
}

static HRESULT WINAPI MyDuplicateSoundBuffer(void* pThis, void* pDSBufferOriginal,
                                              void** ppDSBufferDuplicate) {
    HRESULT hr = g_origDuplicateSoundBuffer(pThis, pDSBufferOriginal, ppDSBufferDuplicate);
    if (SUCCEEDED(hr) && ppDSBufferDuplicate && *ppDSBufferDuplicate && g_onBufferDuplicated) {
        g_onBufferDuplicated(pDSBufferOriginal, *ppDSBufferDuplicate);
    }
    return hr;
}

static void HookDirectSoundVtable(void* ds8, const char* tag) {
    if (vtable::HookObject(ds8, 3, &MyCreateSoundBuffer, &g_origCreateSoundBuffer)) {
        Log("%s: hooked CreateSoundBuffer (vtable[3])", tag);
    } else {
        Log("%s: CreateSoundBuffer already hooked (shared vtable), skipping", tag);
    }
    if (g_onBufferDuplicated &&
        vtable::HookObject(ds8, 5, &MyDuplicateSoundBuffer, &g_origDuplicateSoundBuffer)) {
        Log("%s: hooked DuplicateSoundBuffer (vtable[5])", tag);
    }
}

static HRESULT WINAPI MyDirectSoundCreate8(const void* pcGuidDevice, void** ppDS8,
                                            void* pUnkOuter) {
    HRESULT hr = g_origDirectSoundCreate8(pcGuidDevice, ppDS8, pUnkOuter);
    if (SUCCEEDED(hr) && ppDS8 && *ppDS8) {
        g_ds8 = *ppDS8;
        HookDirectSoundVtable(*ppDS8, "DirectSoundCreate8");
    }
    return hr;
}


// ---- 同期マーカー(touhou-recorder reports/88、audio/sync_marker.h) ----------------------
//
// トリガーが置かれたら、ゲーム自身のIDirectSound8から同期マーカーの系列を1回だけ鳴らし、
// Play直前の壁時計時刻をログへ出す。ゲームのBGM/SEと同じミキサー・同じPulseAudioストリームを
// 通るため、Wine/PulseAudio/ffmpegのいずれの遅延・タイムスタンプのぶれにも左右されない。
//
// バッファのレートは 44100×freqScale Hz(=倍速時の専用シンクのレート、等倍時は
// auto_nullの44100Hz)にし、dsoundミキサーでリサンプルされないようにする。
static const int kSyncMarkerPlayAttempts = 10;

typedef HRESULT(WINAPI* Lock_t)(void* pThis, DWORD dwOffset, DWORD dwBytes, void** ppvAudioPtr1,
                                DWORD* pdwAudioBytes1, void** ppvAudioPtr2,
                                DWORD* pdwAudioBytes2, DWORD dwFlags);
typedef HRESULT(WINAPI* Unlock_t)(void* pThis, void* pvAudioPtr1, DWORD dwAudioBytes1,
                                  void* pvAudioPtr2, DWORD dwAudioBytes2);
typedef HRESULT(WINAPI* Play_t)(void* pThis, DWORD dwReserved1, DWORD dwPriority, DWORD dwFlags);
typedef ULONG(WINAPI* Release_t)(void* pThis);

struct WaveFormatExMin {
    WORD wFormatTag;
    WORD nChannels;
    DWORD nSamplesPerSec;
    DWORD nAvgBytesPerSec;
    WORD nBlockAlign;
    WORD wBitsPerSample;
    WORD cbSize;
};

static bool PlaySyncMarker() {
    void* ds = g_ds8;
    if (!ds || !g_origCreateSoundBuffer) return false;
    DWORD rate = (DWORD)(44100.0 * g_freqScale + 0.5);

    WaveFormatExMin wf = {};
    wf.wFormatTag = 1;  // WAVE_FORMAT_PCM
    wf.nChannels = 1;
    wf.nSamplesPerSec = rate;
    wf.wBitsPerSample = 16;
    wf.nBlockAlign = 2;
    wf.nAvgBytesPerSec = rate * 2;
    DSBufferDescMin bd = {};
    bd.dwSize = sizeof(bd);
    // DSBCAPS_GLOBALFOCUS(0x8000) | DSBCAPS_GETCURRENTPOSITION2(0x10000)
    bd.dwFlags = 0x00008000 | 0x00010000;
    bd.dwBufferBytes = sync_marker::kSamples * 2;
    bd.lpwfxFormat = &wf;

    void* buf = nullptr;
    // フック済みのMyCreateSoundBufferを通すと初期周波数がさらにfreqScale倍されるため、
    // 元の関数を直接呼ぶ。
    HRESULT hr = g_origCreateSoundBuffer(ds, &bd, &buf, nullptr);
    if (FAILED(hr) || !buf) {
        Log("SyncMarker: CreateSoundBuffer failed hr=0x%08lX", (unsigned long)hr);
        return false;
    }
    void** vt = *(void***)buf;
    void *p1 = nullptr, *p2 = nullptr;
    DWORD n1 = 0, n2 = 0;
    hr = ((Lock_t)vt[11])(buf, 0, bd.dwBufferBytes, &p1, &n1, &p2, &n2, 0);
    if (FAILED(hr) || !p1) {
        Log("SyncMarker: Lock failed hr=0x%08lX", (unsigned long)hr);
        ((Release_t)vt[2])(buf);
        return false;
    }
    short* s = (short*)p1;
    sync_marker::Sequence seq;
    for (DWORD i = 0; i < n1 / 2; i++) s[i] = (short)seq.Next();
    ((Unlock_t)vt[19])(buf, p1, n1, p2, n2);

    double t0 = sync_marker::EpochNow();
    hr = ((Play_t)vt[12])(buf, 0, 0, 0);
    double t1 = sync_marker::EpochNow();
    sync_marker::LogPlayed(t0, t1 - t0, rate, hr);
    Sleep((DWORD)(1000.0 * sync_marker::kSamples / rate) + 1000);
    ((Release_t)vt[2])(buf);
    return SUCCEEDED(hr);
}

static bool SyncMarkerReady() { return g_ds8 != nullptr; }

static void OnSyncMarkerTrigger() {
    // ゲームがまだSetCooperativeLevelを呼んでいない等でバッファを作れなかった場合に
    // 備え、少し待って数回だけやり直す(やり直しても鳴らせなければ録画側は
    // start_timeの差による補正へフォールバックする)。
    for (int attempt = 0; attempt < kSyncMarkerPlayAttempts; attempt++) {
        if (PlaySyncMarker()) return;
        Sleep(100);
    }
    Log("SyncMarker: %d回試みても再生できませんでした", kSyncMarkerPlayAttempts);
}

static void InitFreqScale() {
    const double hz = Config().fpsLimitTargetHz;
    g_freqScale = hz > 0.0 ? hz / 60.0 : 1.0;
}

bool InstallDSoundHook() {
    InitFreqScale();
    // DirectSoundCreate8は名前ではなく序数(11)でインポートされている。
    bool ok = iat::HookTyped(nullptr, "dsound.dll", iat::Ordinal{11}, &MyDirectSoundCreate8,
                             &g_origDirectSoundCreate8);
    Log("InstallDSoundHook: IAT hook %s (freqScale=%.4f)",
        ok ? "OK" : "FAILED (DirectSoundCreate8 ordinal 11 not found in IAT)", g_freqScale);
    if (ok) {
        sync_marker::Arm(sync_marker::Watch{"SyncMarker", SyncMarkerReady, OnSyncMarkerTrigger, true},
                         "InstallDSoundHook");
    }
    return ok;
}

void* WrapDirectSoundCreate8(void* real) {
    if (!real) return real;
    if (!g_origDirectSoundCreate8) g_origDirectSoundCreate8 = (DirectSoundCreate8_t)real;
    return (void*)MyDirectSoundCreate8;
}

void HookDirectSoundObject(void* ds8) {
    if (!ds8) return;
    g_ds8 = ds8;
    HookDirectSoundVtable(ds8, "HookDirectSoundObject");
}

namespace dsound {
void SetBufferCallbacks(BufferCreatedCallback onCreated, BufferDuplicatedCallback onDuplicated) {
    g_onBufferCreated = onCreated;
    g_onBufferDuplicated = onDuplicated;
}
}  // namespace dsound

} // namespace autoplay
