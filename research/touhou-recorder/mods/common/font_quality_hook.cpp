#include "font_quality_hook.h"
#include "logging.h"
#include <stdlib.h>

namespace autoplay {

static BYTE g_forcedQuality = ANTIALIASED_QUALITY;

// ゲームが渡すANSI文字列(日本語版はCP932)をログ用にUTF-8へ変換する。ログはrecorderが
// UTF-8として読むため、生のCP932を書くとUnicodeDecodeErrorで録画が止まる(reports/101)。
static const char* AnsiToUtf8(const char* s, char* out, int outLen) {
    if (!s) { out[0] = 0; return out; }
    WCHAR w[512];
    int n = MultiByteToWideChar(932, 0, s, -1, w, 512);
    if (n <= 0 || WideCharToMultiByte(CP_UTF8, 0, w, -1, out, outLen, NULL, NULL) <= 0) {
        int j = 0;
        for (const unsigned char* p = (const unsigned char*)s; *p && j < outLen - 5; p++) {
            if (*p < 0x80) out[j++] = (char)*p;
            else j += wsprintfA(out + j, "\\x%02X", *p);
        }
        out[j] = 0;
    }
    return out;
}

static inline BYTE EffectiveQuality(BYTE requested) {
    return g_forcedQuality == FONT_QUALITY_NO_OVERRIDE ? requested : g_forcedQuality;
}

typedef HFONT(WINAPI* CreateFontA_t)(int, int, int, int, int, DWORD, DWORD, DWORD, DWORD,
                                      DWORD, DWORD, DWORD, DWORD, LPCSTR);
typedef HFONT(WINAPI* CreateFontW_t)(int, int, int, int, int, DWORD, DWORD, DWORD, DWORD,
                                      DWORD, DWORD, DWORD, DWORD, LPCWSTR);
typedef HFONT(WINAPI* CreateFontIndirectA_t)(const LOGFONTA*);
typedef HFONT(WINAPI* CreateFontIndirectW_t)(const LOGFONTW*);
typedef HFONT(WINAPI* CreateFontIndirectExA_t)(const ENUMLOGFONTEXDVA*);
typedef HFONT(WINAPI* CreateFontIndirectExW_t)(const ENUMLOGFONTEXDVW*);

static CreateFontA_t g_origCreateFontA = nullptr;
static CreateFontW_t g_origCreateFontW = nullptr;
static CreateFontIndirectA_t g_origCreateFontIndirectA = nullptr;
static CreateFontIndirectW_t g_origCreateFontIndirectW = nullptr;
static CreateFontIndirectExA_t g_origCreateFontIndirectExA = nullptr;
static CreateFontIndirectExW_t g_origCreateFontIndirectExW = nullptr;

static bool HookIATEntry(const char* dllName, const char* funcName, void* newFunc,
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
            if (IMAGE_SNAP_BY_ORDINAL(ithunk->u1.Ordinal)) continue;
            auto* byName = (IMAGE_IMPORT_BY_NAME*)(base + ithunk->u1.AddressOfData);
            if (_stricmp((char*)byName->Name, funcName) != 0) continue;

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

static HFONT WINAPI MyCreateFontA(int nHeight, int nWidth, int nEscapement, int nOrientation,
                                   int fnWeight, DWORD fdwItalic, DWORD fdwUnderline,
                                   DWORD fdwStrikeOut, DWORD fdwCharSet,
                                   DWORD fdwOutputPrecision, DWORD fdwClipPrecision,
                                   DWORD fdwQuality, DWORD fdwPitchAndFamily, LPCSTR lpszFace) {
    BYTE eff = EffectiveQuality((BYTE)fdwQuality);
    char face[256];
    Log("CreateFontA: face='%s' height=%d weight=%d quality=%lu -> %d",
        AnsiToUtf8(lpszFace, face, sizeof(face)), nHeight, fnWeight, fdwQuality, eff);
    return g_origCreateFontA(nHeight, nWidth, nEscapement, nOrientation, fnWeight, fdwItalic,
                              fdwUnderline, fdwStrikeOut, fdwCharSet, fdwOutputPrecision,
                              fdwClipPrecision, eff, fdwPitchAndFamily, lpszFace);
}

static HFONT WINAPI MyCreateFontW(int nHeight, int nWidth, int nEscapement, int nOrientation,
                                   int fnWeight, DWORD fdwItalic, DWORD fdwUnderline,
                                   DWORD fdwStrikeOut, DWORD fdwCharSet,
                                   DWORD fdwOutputPrecision, DWORD fdwClipPrecision,
                                   DWORD fdwQuality, DWORD fdwPitchAndFamily, LPCWSTR lpszFace) {
    BYTE eff = EffectiveQuality((BYTE)fdwQuality);
    Log("CreateFontW: height=%d weight=%d quality=%lu -> %d", nHeight, fnWeight, fdwQuality, eff);
    return g_origCreateFontW(nHeight, nWidth, nEscapement, nOrientation, fnWeight, fdwItalic,
                              fdwUnderline, fdwStrikeOut, fdwCharSet, fdwOutputPrecision,
                              fdwClipPrecision, eff, fdwPitchAndFamily, lpszFace);
}

static HFONT WINAPI MyCreateFontIndirectA(const LOGFONTA* lf) {
    if (lf) {
        LOGFONTA copy = *lf;
        BYTE eff = EffectiveQuality(copy.lfQuality);
        char face[256];
        Log("CreateFontIndirectA: face='%s' height=%ld weight=%ld quality=%u -> %u",
            AnsiToUtf8(copy.lfFaceName, face, sizeof(face)),
            (long)copy.lfHeight, (long)copy.lfWeight, copy.lfQuality, eff);
        copy.lfQuality = eff;
        return g_origCreateFontIndirectA(&copy);
    }
    return g_origCreateFontIndirectA(lf);
}

static HFONT WINAPI MyCreateFontIndirectW(const LOGFONTW* lf) {
    if (lf) {
        LOGFONTW copy = *lf;
        BYTE eff = EffectiveQuality(copy.lfQuality);
        Log("CreateFontIndirectW: height=%ld weight=%ld quality=%u -> %u", (long)copy.lfHeight,
            (long)copy.lfWeight, copy.lfQuality, eff);
        copy.lfQuality = eff;
        return g_origCreateFontIndirectW(&copy);
    }
    return g_origCreateFontIndirectW(lf);
}

static HFONT WINAPI MyCreateFontIndirectExA(const ENUMLOGFONTEXDVA* lf) {
    if (lf) {
        ENUMLOGFONTEXDVA copy = *lf;
        BYTE eff = EffectiveQuality(copy.elfEnumLogfontEx.elfLogFont.lfQuality);
        char face[256];
        Log("CreateFontIndirectExA: face='%s' quality=%u -> %u",
            AnsiToUtf8((const char*)copy.elfEnumLogfontEx.elfLogFont.lfFaceName, face, sizeof(face)),
            copy.elfEnumLogfontEx.elfLogFont.lfQuality,
            eff);
        copy.elfEnumLogfontEx.elfLogFont.lfQuality = eff;
        return g_origCreateFontIndirectExA(&copy);
    }
    return g_origCreateFontIndirectExA(lf);
}

static HFONT WINAPI MyCreateFontIndirectExW(const ENUMLOGFONTEXDVW* lf) {
    if (lf) {
        ENUMLOGFONTEXDVW copy = *lf;
        BYTE eff = EffectiveQuality(copy.elfEnumLogfontEx.elfLogFont.lfQuality);
        Log("CreateFontIndirectExW: quality=%u -> %u",
            copy.elfEnumLogfontEx.elfLogFont.lfQuality, eff);
        copy.elfEnumLogfontEx.elfLogFont.lfQuality = eff;
        return g_origCreateFontIndirectExW(&copy);
    }
    return g_origCreateFontIndirectExW(lf);
}

// --- 描画経路の診断(reports/101) ---
// TextOutA: 文字列と、そのとき DC に選択されているフォント・文字色・DCのビットマップ形式を記録する。
// CreateDIBSection: テキスト描画先のDIBのビット深度を記録する。毎フレーム呼ばれても
// ログが溢れないよう、それぞれ先頭 kMaxProbeLogs 件だけ記録する。
typedef BOOL(WINAPI* TextOutA_t)(HDC, int, int, LPCSTR, int);
typedef HBITMAP(WINAPI* CreateDIBSection_t)(HDC, const BITMAPINFO*, UINT, void**, HANDLE, DWORD);
static TextOutA_t g_origTextOutA = nullptr;
static CreateDIBSection_t g_origCreateDIBSection = nullptr;
static const LONG kMaxProbeLogs = 400;
static volatile LONG g_textOutLogs = 0;
static volatile LONG g_dibLogs = 0;

// FONT_PROBE_DUMP_DIR が指定されていれば、空白以外の TextOutA の直前・直後に描画先DIBの
// 生データ(ヘッダ: width,height,bpp,stride,masks[3] の DWORD x7 + 画素)を
// <dir>/textout_<n>_{pre,post}.bin に書き出す(先頭 kMaxDumps 回まで)。
static const LONG kMaxDumps = 12;
static volatile LONG g_dumps = 0;

static void DumpDib(HDC dc, LONG n, const char* tag) {
    const char* dir = getenv("FONT_PROBE_DUMP_DIR");
    if (!dir) return;
    DIBSECTION ds = {};
    if (GetObjectA(GetCurrentObject(dc, OBJ_BITMAP), sizeof(ds), &ds) != sizeof(ds) || !ds.dsBm.bmBits)
        return;
    GdiFlush();
    char path[MAX_PATH];
    wsprintfA(path, "%s\\textout_%02ld_%s.bin", dir, n, tag);
    HANDLE f = CreateFileA(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, 0, NULL);
    if (f == INVALID_HANDLE_VALUE) return;
    DWORD hdr[7] = {(DWORD)ds.dsBm.bmWidth, (DWORD)ds.dsBm.bmHeight, ds.dsBm.bmBitsPixel,
                    (DWORD)ds.dsBm.bmWidthBytes, ds.dsBitfields[0], ds.dsBitfields[1], ds.dsBitfields[2]};
    DWORD w;
    WriteFile(f, hdr, sizeof(hdr), &w, NULL);
    WriteFile(f, ds.dsBm.bmBits, ds.dsBm.bmWidthBytes * ds.dsBm.bmHeight, &w, NULL);
    CloseHandle(f);
}

static BOOL WINAPI MyTextOutA(HDC dc, int x, int y, LPCSTR str, int len) {
    LONG dumpNo = -1;
    if (str && len > 1 && getenv("FONT_PROBE_DUMP_DIR")) {
        LONG n = InterlockedIncrement(&g_dumps);
        if (n <= kMaxDumps) { dumpNo = n; DumpDib(dc, n, "pre"); }
    }
    BOOL ret = g_origTextOutA(dc, x, y, str, len);
    if (dumpNo > 0) DumpDib(dc, dumpNo, "post");
    if (InterlockedIncrement(&g_textOutLogs) <= kMaxProbeLogs) {
        char raw[256] = {0}, text[768];
        int n = len < 255 ? len : 255;
        if (str && n > 0) memcpy(raw, str, n);
        LOGFONTA lf = {};
        GetObjectA(GetCurrentObject(dc, OBJ_FONT), sizeof(lf), &lf);
        DIBSECTION ds = {};
        int bpp = GetObjectA(GetCurrentObject(dc, OBJ_BITMAP), sizeof(ds), &ds) ? ds.dsBm.bmBitsPixel : -1;
        Log("TextOutA: (%d,%d) h=%ld w=%ld q=%u color=%06lX bkmode=%d bpp=%d text='%s'", x, y,
            (long)lf.lfHeight, (long)lf.lfWeight, lf.lfQuality, (unsigned long)GetTextColor(dc),
            GetBkMode(dc), bpp, AnsiToUtf8(raw, text, sizeof(text)));
    }
    return ret;
}

static HBITMAP WINAPI MyCreateDIBSection(HDC dc, const BITMAPINFO* bmi, UINT usage, void** bits,
                                          HANDLE section, DWORD offset) {
    if (bmi && InterlockedIncrement(&g_dibLogs) <= kMaxProbeLogs) {
        const DWORD* m = (const DWORD*)bmi->bmiColors;
        Log("CreateDIBSection: %ldx%ld bpp=%u compression=%lu masks=%08lX,%08lX,%08lX",
            (long)bmi->bmiHeader.biWidth, (long)bmi->bmiHeader.biHeight, bmi->bmiHeader.biBitCount,
            (unsigned long)bmi->bmiHeader.biCompression,
            bmi->bmiHeader.biCompression == BI_BITFIELDS ? (unsigned long)m[0] : 0UL,
            bmi->bmiHeader.biCompression == BI_BITFIELDS ? (unsigned long)m[1] : 0UL,
            bmi->bmiHeader.biCompression == BI_BITFIELDS ? (unsigned long)m[2] : 0UL);
    }
    return g_origCreateDIBSection(dc, bmi, usage, bits, section, offset);
}

int InstallFontQualityHook(BYTE forcedQuality) {
    g_forcedQuality = forcedQuality;
    int count = 0;
    if (HookIATEntry("gdi32.dll", "CreateFontA", (void*)MyCreateFontA,
                      (void**)&g_origCreateFontA))
        count++;
    if (HookIATEntry("gdi32.dll", "CreateFontW", (void*)MyCreateFontW,
                      (void**)&g_origCreateFontW))
        count++;
    if (HookIATEntry("gdi32.dll", "CreateFontIndirectA", (void*)MyCreateFontIndirectA,
                      (void**)&g_origCreateFontIndirectA))
        count++;
    if (HookIATEntry("gdi32.dll", "CreateFontIndirectW", (void*)MyCreateFontIndirectW,
                      (void**)&g_origCreateFontIndirectW))
        count++;
    if (HookIATEntry("gdi32.dll", "CreateFontIndirectExA", (void*)MyCreateFontIndirectExA,
                      (void**)&g_origCreateFontIndirectExA))
        count++;
    if (HookIATEntry("gdi32.dll", "CreateFontIndirectExW", (void*)MyCreateFontIndirectExW,
                      (void**)&g_origCreateFontIndirectExW))
        count++;
    if (forcedQuality == FONT_QUALITY_NO_OVERRIDE) {
        HookIATEntry("gdi32.dll", "TextOutA", (void*)MyTextOutA, (void**)&g_origTextOutA);
        HookIATEntry("gdi32.dll", "CreateDIBSection", (void*)MyCreateDIBSection,
                     (void**)&g_origCreateDIBSection);
    }
    Log("InstallFontQualityHook: hooked %d/6 GDI font-creation entry points (forcedQuality=%u)",
        count, forcedQuality);
    return count;
}

} // namespace autoplay
