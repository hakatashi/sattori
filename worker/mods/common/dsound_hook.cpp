#include "dsound_hook.h"
#include "logging.h"
#include <stdlib.h>

namespace autoplay {

// COM interface信頼のため、DirectX SDKヘッダを使わずABI互換な素の型のみで宣言する
// (mods/common/fps_limiter_hook.cppと同じ方針)。

typedef HRESULT(WINAPI* DirectSoundCreate8_t)(const void* pcGuidDevice, void** ppDS8,
                                               void* pUnkOuter);
typedef HRESULT(WINAPI* CreateSoundBuffer_t)(void* pThis, const void* pcDSBufferDesc,
                                              void** ppDSBuffer, void* pUnkOuter);
typedef HRESULT(WINAPI* GetFrequency_t)(void* pThis, DWORD* lpdwFrequency);
typedef HRESULT(WINAPI* SetFrequency_t)(void* pThis, DWORD dwFrequency);

static DirectSoundCreate8_t g_origDirectSoundCreate8 = nullptr;
static CreateSoundBuffer_t g_origCreateSoundBuffer = nullptr;
static SetFrequency_t g_origSetFrequency = nullptr;

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

static void PatchVTable(void** vtable, int index, void* newFunc, void** outOld) {
    DWORD oldProt;
    VirtualProtect(&vtable[index], sizeof(void*), PAGE_EXECUTE_READWRITE, &oldProt);
    if (outOld) *outOld = vtable[index];
    vtable[index] = newFunc;
    VirtualProtect(&vtable[index], sizeof(void*), oldProt, &oldProt);
}

// fps_limiter_hook.cppのHookIATEntryと異なり、DirectSoundCreate8はOrdinalインポート
// (名前なし)されているため、名前一致ではなくOrdinal一致で検索する。
static bool HookIATEntryByOrdinal(const char* dllName, WORD ordinal, void* newFunc,
                                   void** outOld) {
    HMODULE hExe = GetModuleHandle(NULL);
    BYTE* base = (BYTE*)hExe;
    auto* dos = (IMAGE_DOS_HEADER*)base;
    auto* nt = (IMAGE_NT_HEADERS*)(base + dos->e_lfanew);
    auto& dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (dir.VirtualAddress == 0) return false;
    auto* imp = (IMAGE_IMPORT_DESCRIPTOR*)(base + dir.VirtualAddress);

    for (; imp->Name; imp++) {
        if (_stricmp((char*)(base + imp->Name), dllName) != 0) continue;

        auto* thunk = (IMAGE_THUNK_DATA*)(base + imp->FirstThunk);
        auto* ithunk = (IMAGE_THUNK_DATA*)(base + imp->OriginalFirstThunk);
        for (; thunk->u1.Function; thunk++, ithunk++) {
            if (!IMAGE_SNAP_BY_ORDINAL(ithunk->u1.Ordinal)) continue;
            if (IMAGE_ORDINAL(ithunk->u1.Ordinal) != ordinal) continue;

            DWORD oldProt;
            VirtualProtect(&thunk->u1.Function, sizeof(void*), PAGE_EXECUTE_READWRITE,
                            &oldProt);
            if (outOld) *outOld = (void*)thunk->u1.Function;
            thunk->u1.Function = (ULONG_PTR)newFunc;
            VirtualProtect(&thunk->u1.Function, sizeof(void*), oldProt, &oldProt);
            return true;
        }
    }
    return false;
}

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
        // プライマリバッファには何もしない。Wineではプライマリのフォーマットを
        // いじっても実際の出力ストリームのレートは変わらない(下記ヘッダのコメント参照)。
        if (!isPrimary) {
            void** vtable = *(void***)(*ppDSBuffer);
            // dinput_hook.cppの多重CreateDeviceフック対策と同じ理由(静的vtable共有)で、
            // 複数回CreateSoundBufferが呼ばれる可能性に備えて既にフック済みかを確認する。
            if (vtable[17] != (void*)MySetFrequency) {
                PatchVTable(vtable, 17, (void*)MySetFrequency, (void**)&g_origSetFrequency);
                Log("CreateSoundBuffer: hooked SetFrequency (vtable[17])");
            }
            if (g_freqScale != 1.0) {
                // ゲームが一度もSetFrequencyを呼ばない場合に備え、初期周波数にも
                // スケールを適用する(g_origSetFrequency直接呼び出しのためMySetFrequency
                // 経由の二重スケールにはならない)。
                GetFrequency_t getFreq = (GetFrequency_t)vtable[8];
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

static HRESULT WINAPI MyDirectSoundCreate8(const void* pcGuidDevice, void** ppDS8,
                                            void* pUnkOuter) {
    HRESULT hr = g_origDirectSoundCreate8(pcGuidDevice, ppDS8, pUnkOuter);
    if (SUCCEEDED(hr) && ppDS8 && *ppDS8) {
        g_ds8 = *ppDS8;
        void** vtable = *(void***)(*ppDS8);
        if (vtable[3] != (void*)MyCreateSoundBuffer) {
            PatchVTable(vtable, 3, (void*)MyCreateSoundBuffer, (void**)&g_origCreateSoundBuffer);
            Log("DirectSoundCreate8: hooked CreateSoundBuffer (vtable[3])");
        } else {
            Log("DirectSoundCreate8: CreateSoundBuffer already hooked (shared vtable), skipping");
        }
    }
    return hr;
}


// ---- 同期マーカー(フェーズ88) ----------------------------------------------------
//
// 録画パイプラインが音声録音を開始した後にトリガーファイル(環境変数
// SYNC_MARKER_TRIGGER)を置くと、ゲーム自身のIDirectSound8から低レベルの
// 疑似乱数ノイズ(±kSyncMarkerAmp、kSyncMarkerSamplesサンプル)を1回だけ鳴らし、
// Play直前の壁時計時刻(UNIX epoch秒)をログへ出す。録画後にrecorder/sync_marker.pyが
// 同じ系列を相互相関で探し、「音声ファイル上の位置 ↔ 発音をゲームが指示した時刻」の
// 対応を直接求める。ゲームのBGM/SEと同じミキサー・同じPulseAudioストリームを通るため、
// Wine/PulseAudio/ffmpegのいずれの遅延・タイムスタンプのぶれにも左右されない。
//
// バッファのレートは 44100×freqScale Hz(=倍速時の専用シンクのレート、等倍時は
// auto_nullの44100Hz)にし、dsoundミキサーでリサンプルされないようにする。
// 系列は xorshift32(seed=0x2545F491)の最下位ビットで、Python側と完全に一致させること。
static const DWORD kSyncMarkerSamples = 131072;
static const short kSyncMarkerAmp = 256;  // -42dBFS。Wineのミキサーで各chへ約-6dB減衰して入る(reports/88)
static const DWORD kSyncMarkerSeed = 0x2545F491u;

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

static double EpochNow() {
    FILETIME ft;
    GetSystemTimePreciseAsFileTime(&ft);
    ULONGLONG t = ((ULONGLONG)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
    return (double)(t - 116444736000000000ULL) / 1e7;
}

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
    bd.dwBufferBytes = kSyncMarkerSamples * 2;
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
    DWORD x = kSyncMarkerSeed;
    for (DWORD i = 0; i < n1 / 2; i++) {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        s[i] = (x & 1) ? kSyncMarkerAmp : (short)-kSyncMarkerAmp;
    }
    ((Unlock_t)vt[19])(buf, p1, n1, p2, n2);

    double t0 = EpochNow();
    hr = ((Play_t)vt[12])(buf, 0, 0, 0);
    double t1 = EpochNow();
    Log("SYNC_MARKER played epoch=%.6f play_call_sec=%.6f rate=%lu samples=%lu amp=%d seed=0x%08lX "
        "hr=0x%08lX",
        t0, t1 - t0, (unsigned long)rate, (unsigned long)kSyncMarkerSamples, (int)kSyncMarkerAmp,
        (unsigned long)kSyncMarkerSeed, (unsigned long)hr);
    Sleep((DWORD)(1000.0 * kSyncMarkerSamples / rate) + 1000);
    ((Release_t)vt[2])(buf);
    return SUCCEEDED(hr);
}

static DWORD WINAPI SyncMarkerThread(LPVOID param) {
    const char* path = (const char*)param;
    // 録画は数十分に及ぶことがあるが、トリガーは録画開始直後に置かれる。念のため長めに待つ。
    for (int i = 0; i < 20 * 60 * 200; i++) {
        if (GetFileAttributesA(path) != INVALID_FILE_ATTRIBUTES && g_ds8) {
            Log("SyncMarker: trigger found (%s)", path);
            PlaySyncMarker();
            return 0;
        }
        Sleep(5);
    }
    Log("SyncMarker: trigger not found within timeout");
    return 0;
}

static void InitFreqScale(double freqScale) {
    g_freqScale = freqScale;
    const char* env = getenv("FPS_LIMIT_TARGET_HZ");
    if (env) {
        double hz = atof(env);
        if (hz > 0.0) g_freqScale = hz / 60.0;
    }
    if (g_freqScale <= 0.0) g_freqScale = 1.0;
}

// 同期マーカー(フェーズ88)。Wine内のMODから開けるよう、録画パイプライン側で
// Windows形式(Z:\...)に変換したパスを受け取る。
static void ArmSyncMarker() {
    const char* trig = getenv("SYNC_MARKER_TRIGGER");
    if (!trig || !*trig) return;
    static char s_path[MAX_PATH];
    static bool s_armed = false;
    if (s_armed) return;
    s_armed = true;
    lstrcpynA(s_path, trig, MAX_PATH);
    HANDLE th = CreateThread(nullptr, 0, SyncMarkerThread, s_path, 0, nullptr);
    if (th) CloseHandle(th);
    Log("InstallDSoundHook: sync marker armed (trigger=%s)", s_path);
}

bool InstallDSoundHook(double freqScale) {
    InitFreqScale(freqScale);
    bool ok = HookIATEntryByOrdinal("dsound.dll", 11, (void*)MyDirectSoundCreate8,
                                     (void**)&g_origDirectSoundCreate8);
    Log("InstallDSoundHook: IAT hook %s (freqScale=%.4f)",
        ok ? "OK" : "FAILED (DirectSoundCreate8 ordinal 11 not found in IAT)", g_freqScale);
    if (ok) ArmSyncMarker();
    return ok;
}

void InitDSoundHookDynamic(double freqScale) {
    InitFreqScale(freqScale);
    Log("InitDSoundHookDynamic: freqScale=%.4f", g_freqScale);
    ArmSyncMarker();
}

void* WrapDirectSoundCreate8(void* real) {
    if (!g_origDirectSoundCreate8) g_origDirectSoundCreate8 = (DirectSoundCreate8_t)real;
    return (void*)MyDirectSoundCreate8;
}

void HookDirectSoundObject(void* ds8) {
    if (!ds8) return;
    g_ds8 = ds8;
    void** vtable = *(void***)ds8;
    if (vtable[3] != (void*)MyCreateSoundBuffer) {
        PatchVTable(vtable, 3, (void*)MyCreateSoundBuffer, (void**)&g_origCreateSoundBuffer);
        Log("HookDirectSoundObject: hooked CreateSoundBuffer (vtable[3])");
    }
}

} // namespace autoplay
