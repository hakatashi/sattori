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
    if (SUCCEEDED(hr) && ppDSBuffer && *ppDSBuffer && !isPrimary) {
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
    return hr;
}

static HRESULT WINAPI MyDirectSoundCreate8(const void* pcGuidDevice, void** ppDS8,
                                            void* pUnkOuter) {
    HRESULT hr = g_origDirectSoundCreate8(pcGuidDevice, ppDS8, pUnkOuter);
    if (SUCCEEDED(hr) && ppDS8 && *ppDS8) {
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

bool InstallDSoundHook(double freqScale) {
    g_freqScale = freqScale;
    const char* env = getenv("FPS_LIMIT_TARGET_HZ");
    if (env) {
        double hz = atof(env);
        if (hz > 0.0) g_freqScale = hz / 60.0;
    }
    if (g_freqScale <= 0.0) g_freqScale = 1.0;

    bool ok = HookIATEntryByOrdinal("dsound.dll", 11, (void*)MyDirectSoundCreate8,
                                     (void**)&g_origDirectSoundCreate8);
    Log("InstallDSoundHook: IAT hook %s (freqScale=%.4f)",
        ok ? "OK" : "FAILED (DirectSoundCreate8 ordinal 11 not found in IAT)", g_freqScale);
    return ok;
}

} // namespace autoplay
