// th06c (東方紅魔郷: Classic / TH06C) リプレイ自動再生MOD。
//
// 既存タイトル(th06〜th128)との構造的な違い(フェーズ74の調査結果):
//   * th06c.exe は PE32+ (x86-64)。MOD・injectorとも64bitでビルドする必要がある。
//   * 入力ポーリングが DirectInput でも「IATの」GetKeyboardState でもない。
//     th06c.exe(DXライブラリ系エンジン)は User32.dll を LoadLibrary +
//     GetProcAddress で動的に解決してから GetKeyboardState / GetAsyncKeyState を
//     呼ぶため、IATフックでは一切引っかからない(実機でpoll count=0を確認)。
//     そこで KERNEL32!GetProcAddress の方をIATフックし、入力APIの解決要求に
//     対して自前の関数ポインタを返す方式にしている。
//   * 起動時に「解像度を選択してください」モーダルダイアログ
//     (USER32!DialogBoxIndirectParamW) が毎回表示され、これを閉じないと
//     ゲーム本体が始まらない。ユーザールール上 xdotool による外部入力は使えない
//     ため、プロセス内のワーカースレッドからダイアログのコントロールを直接
//     操作して閉じる。コントロールIDはフェーズ74で実機列挙済み:
//       id=200      ボーダーレスウィンドウ
//       id=201..205 フルスクリーン(最大/3840x2160/2560x1440/1920x1080/1280x720)
//       id=206..210 ウィンドウ(2560x1920/1920x1440/1280x960/960x720/640x480)
//       id=400      VSyncを有効(チェックボックス)
//       id=1        ゲーム起動(IDOK)
//   * Steamworks API が初期化できないと即 exit(255) するため、
//     mods/th06c_steam_stub/ のスタブ steam_api64.dll を併用する。
//
// メニュー操作シーケンス(ユーザー提供、Extra解放済みセーブデータ想定):
//   タイトル画面(ロゴアニメ ~2秒) -> Enter(メニュー表示) ->
//   Down x2 -> Enter("Replay"選択、~2秒の遷移アニメ) ->
//   Enter(1番目のリプレイを選択、~1秒) -> Enter(再生開始)

#include <windows.h>
#include <mmsystem.h>

#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <cstdint>

#include "../common/logging.h"
#include "../common/dsound_hook.h"
#include "../common/wasapi_hook.h"
#include "../common/speed_hack_hook.h"
#include "../common/frame_sync_d3d11.h"
#include "../common/frame_sync_wasapi.h"

using namespace autoplay;

namespace {

// ---------------------------------------------------------------------------
// 起動ダイアログで選ぶ表示モード(コントロールID)
// ---------------------------------------------------------------------------

// ウィンドウ 640x480。オリジナルth06と同じ内部解像度で、既存の録画パイプライン
// (クロップ・アップスケール設定)をそのまま流用できる。
constexpr int kIdWindow640x480 = 210;
constexpr int kIdVSync = 400;
constexpr int kIdStartGame = 1;  // IDOK

// ---------------------------------------------------------------------------
// IATフックの共通処理
// ---------------------------------------------------------------------------

bool HookIATEntry(const char *dllName, const char *funcName, void *newFunc, void **outOld) {
    HMODULE hExe = GetModuleHandle(NULL);
    BYTE *base = (BYTE *)hExe;
    auto *dos = (IMAGE_DOS_HEADER *)base;
    auto *nt = (IMAGE_NT_HEADERS *)(base + dos->e_lfanew);
    auto &dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (dir.VirtualAddress == 0) return false;
    auto *imp = (IMAGE_IMPORT_DESCRIPTOR *)(base + dir.VirtualAddress);

    for (; imp->Name; imp++) {
        if (_stricmp((char *)(base + imp->Name), dllName) != 0) continue;
        auto *thunk = (IMAGE_THUNK_DATA *)(base + imp->FirstThunk);
        auto *ithunk = (IMAGE_THUNK_DATA *)(base + imp->OriginalFirstThunk);
        for (; thunk->u1.Function; thunk++, ithunk++) {
            if (IMAGE_SNAP_BY_ORDINAL(ithunk->u1.Ordinal)) continue;
            auto *byName = (IMAGE_IMPORT_BY_NAME *)(base + ithunk->u1.AddressOfData);
            if (_stricmp((char *)byName->Name, funcName) != 0) continue;
            DWORD oldProt;
            VirtualProtect(&thunk->u1.Function, sizeof(void *), PAGE_EXECUTE_READWRITE, &oldProt);
            if (outOld) *outOld = (void *)thunk->u1.Function;
            thunk->u1.Function = (ULONG_PTR)newFunc;
            VirtualProtect(&thunk->u1.Function, sizeof(void *), oldProt, &oldProt);
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// キー入力注入
// ---------------------------------------------------------------------------

typedef BOOL(WINAPI *GetKeyboardState_t)(PBYTE);
typedef SHORT(WINAPI *GetAsyncKeyState_t)(int);
typedef FARPROC(WINAPI *GetProcAddress_t)(HMODULE, LPCSTR);

GetKeyboardState_t g_origGetKeyboardState = nullptr;
GetAsyncKeyState_t g_origGetAsyncKeyState = nullptr;
GetProcAddress_t g_origGetProcAddress = nullptr;

// 「1フレーム分の入力」の基準にするポーリング回数。ゲームが実際に使っている
// 経路(GetKeyboardState / GetAsyncKeyState のどちらか)の呼び出し回数を数える。
volatile LONG g_pollCount = 0;
volatile BYTE g_injectVk[256] = {0};

// どちらの経路が実際に使われたかの記録(ログ用)
volatile LONG g_kbStateCalls = 0;
volatile LONG g_asyncCalls = 0;

BOOL WINAPI MyGetKeyboardState(PBYTE lpKeyState) {
    BOOL ok = g_origGetKeyboardState ? g_origGetKeyboardState(lpKeyState) : FALSE;
    InterlockedIncrement(&g_pollCount);
    InterlockedIncrement(&g_kbStateCalls);
    if (ok && lpKeyState) {
        for (int i = 0; i < 256; i++) {
            if (g_injectVk[i]) lpKeyState[i] |= 0x80;
        }
    }
    return ok;
}

SHORT WINAPI MyGetAsyncKeyState(int vKey) {
    SHORT result = g_origGetAsyncKeyState ? g_origGetAsyncKeyState(vKey) : 0;
    InterlockedIncrement(&g_asyncCalls);
    if (vKey >= 0 && vKey < 256 && g_injectVk[vKey]) {
        result |= (SHORT)0x8001;
    }
    return result;
}

// MapVirtualKeyExW の呼び出しを記録する。DXライブラリ系エンジンは
// 「スキャンコード -> VK」変換表を作ってから GetKeyboardState を引くため、
// どのスキャンコードがどのVKに解決されたかが分かると、方向キーが効かない原因
// (拡張キーの扱い)を切り分けられる。
typedef UINT(WINAPI *MapVirtualKeyExW_t)(UINT, UINT, HKL);
MapVirtualKeyExW_t g_origMapVirtualKeyExW = nullptr;
volatile LONG g_mapCalls = 0;

UINT WINAPI MyMapVirtualKeyExW(UINT uCode, UINT uMapType, HKL dwhkl) {
    UINT r = g_origMapVirtualKeyExW ? g_origMapVirtualKeyExW(uCode, uMapType, dwhkl) : 0;
    LONG n = InterlockedIncrement(&g_mapCalls);
    // 方向キーに関係するスキャンコード周辺だけ記録する(全部出すと膨大なため)
    if (n <= 400 && (uCode == 0x48 || uCode == 0x4B || uCode == 0x4D || uCode == 0x50 ||
                     uCode == 0xC8 || uCode == 0xCB || uCode == 0xCD || uCode == 0xD0 ||
                     uCode == 0xE048 || uCode == 0xE050 || uCode == 0x1C || uCode == 0x9C)) {
        Log("[MapVirtualKeyEx] code=0x%X type=%u -> 0x%X", uCode, uMapType, r);
    }
    return r;
}

// 倍速録画(reports/90、th06ncのreports/89と同じ仕組み)。DXライブラリは音声デバイスを
// CoCreateInstanceで作る(DirectSound8またはWASAPIのMMDeviceEnumerator)。作られた
// オブジェクトをフックして、倍速時の再生レート偽装と同期マーカー(reports/88)を効かせる。
typedef HRESULT(WINAPI *CoCreateInstance_t)(REFCLSID, LPUNKNOWN, DWORD, REFIID, LPVOID *);
CoCreateInstance_t g_origCoCreateInstance = nullptr;
const GUID kCLSID_DirectSound8 = {0x3901cc3f, 0x84b5, 0x4fa4, {0xba, 0x35, 0xaa, 0x81, 0x72, 0xb8, 0xa0, 0x9b}};
const GUID kCLSID_DirectSound = {0x47d4d946, 0x62e8, 0x11cf, {0x93, 0xbc, 0x44, 0x45, 0x53, 0x54, 0x00, 0x00}};
const GUID kCLSID_MMDeviceEnumerator = {0xbcde0395, 0xe52f, 0x467c, {0x8e, 0x3d, 0xc4, 0x57, 0x92, 0x91, 0x69, 0x2e}};

HRESULT WINAPI MyCoCreateInstance(REFCLSID rclsid, LPUNKNOWN outer, DWORD ctx, REFIID riid, LPVOID *ppv) {
    HRESULT hr = g_origCoCreateInstance(rclsid, outer, ctx, riid, ppv);
    Log("CoCreateInstance: clsid={%08lX-%04X-%04X-...} hr=0x%08lX", (unsigned long)rclsid.Data1,
        rclsid.Data2, rclsid.Data3, (unsigned long)hr);
    if (SUCCEEDED(hr) && ppv && *ppv &&
        (IsEqualGUID(rclsid, kCLSID_DirectSound8) || IsEqualGUID(rclsid, kCLSID_DirectSound))) {
        HookDirectSoundObject(*ppv);
    }
    if (SUCCEEDED(hr) && ppv && *ppv && IsEqualGUID(rclsid, kCLSID_MMDeviceEnumerator)) {
        if (FrameSyncWasapiActive()) HookMMDeviceEnumeratorForFrameSync(*ppv);
        else HookMMDeviceEnumerator(*ppv);
    }
    return hr;
}

FARPROC WINAPI MyGetProcAddress(HMODULE hModule, LPCSTR lpProcName) {
    FARPROC real = g_origGetProcAddress(hModule, lpProcName);

    // 序数指定(HIWORDが0)の場合は名前を持たないのでそのまま返す
    if (!lpProcName || ((ULONG_PTR)lpProcName >> 16) == 0) return real;

    if (strcmp(lpProcName, "GetKeyboardState") == 0) {
        if (!g_origGetKeyboardState) {
            g_origGetKeyboardState = (GetKeyboardState_t)real;
            Log("GetProcAddress hook: GetKeyboardState を自前実装に差し替えました");
        }
        return (FARPROC)MyGetKeyboardState;
    }
    if (strcmp(lpProcName, "GetAsyncKeyState") == 0) {
        if (!g_origGetAsyncKeyState) {
            g_origGetAsyncKeyState = (GetAsyncKeyState_t)real;
            Log("GetProcAddress hook: GetAsyncKeyState を自前実装に差し替えました");
        }
        return (FARPROC)MyGetAsyncKeyState;
    }

    // 倍速録画(reports/90)。DXライブラリは時刻・音声APIもGetProcAddressで動的に取得するため、
    // IATではなくここで差し替える(th06ncと同じ)。
    if (strcmp(lpProcName, "DirectSoundCreate8") == 0) {
        Log("GetProcAddress hook: DirectSoundCreate8 をフック版に差し替えました");
        return (FARPROC)WrapDirectSoundCreate8((void *)real);
    }
    if (strcmp(lpProcName, "timeGetTime") == 0) {
        if (FrameSyncD3D11Active()) return (FARPROC)WrapTimeGetTimeForFrameSync((void *)real);
        return (FARPROC)WrapTimeGetTimeForSpeedHack((void *)real);
    }
    if (strcmp(lpProcName, "CoCreateInstance") == 0) {
        if (!g_origCoCreateInstance) g_origCoCreateInstance = (CoCreateInstance_t)real;
        return (FARPROC)MyCoCreateInstance;
    }
    if (strcmp(lpProcName, "QueryPerformanceCounter") == 0) {
        Log("GetProcAddress hook: QueryPerformanceCounter を差し替えました");
        if (FrameSyncD3D11Active()) return (FARPROC)WrapQPCForFrameSync((void *)real);
        return (FARPROC)WrapQueryPerformanceCounterForSpeedHack((void *)real);
    }
    if (strcmp(lpProcName, "GetTickCount") == 0) {
        return (FARPROC)WrapGetTickCountForFrameSync((void *)real);
    }
    if (strcmp(lpProcName, "GetTickCount64") == 0) {
        return (FARPROC)WrapGetTickCount64ForFrameSync((void *)real);
    }
    if (strcmp(lpProcName, "Sleep") == 0) {
        return (FARPROC)WrapSleepForFrameSync((void *)real);
    }
    if (strcmp(lpProcName, "WaitForSingleObject") == 0) {
        return (FARPROC)WrapWaitForSingleObjectForFrameSync((void *)real);
    }
    if (strcmp(lpProcName, "D3D11CreateDevice") == 0) {
        return (FARPROC)WrapD3D11CreateDeviceForFrameSync((void *)real);
    }
    if (strcmp(lpProcName, "D3D11CreateDeviceAndSwapChain") == 0) {
        return (FARPROC)WrapD3D11CreateDeviceAndSwapChainForFrameSync((void *)real);
    }
    if (strcmp(lpProcName, "CreateDXGIFactory") == 0) {
        return (FARPROC)WrapCreateDXGIFactoryForFrameSync((void *)real);
    }
    if (strcmp(lpProcName, "CreateDXGIFactory1") == 0) {
        return (FARPROC)WrapCreateDXGIFactory1ForFrameSync((void *)real);
    }
    if (strcmp(lpProcName, "CreateDXGIFactory2") == 0) {
        return (FARPROC)WrapCreateDXGIFactory2ForFrameSync((void *)real);
    }
    if (strstr(lpProcName, "Sound") || strstr(lpProcName, "XAudio") ||
        strstr(lpProcName, "timeGet") || strstr(lpProcName, "Performance")) {
        Log("GetProcAddress: %s -> %p", lpProcName, (void *)real);
    }

    // 入力周りで他に何を解決しているかの手掛かりを残す
    if (strstr(lpProcName, "Key") || strstr(lpProcName, "RawInput") ||
        strstr(lpProcName, "XInput") || strstr(lpProcName, "joyGet")) {
        Log("GetProcAddress: %s -> %p", lpProcName, (void *)real);
    }
    return real;
}

// g_pollCount が start から frames 回進むまで待つ
void WaitFrames(LONG start, unsigned int frames, unsigned int timeoutMs) {
    DWORD deadline = GetTickCount() + timeoutMs;
    while ((LONG)(g_pollCount - start) < (LONG)frames) {
        if (GetTickCount() > deadline) return;
        Sleep(1);
    }
}

// 入力ポーリングの実効レート(=実効描画fps相当)を一定間隔でログし続ける常駐スレッド。
// 出力形式は mods/common/fps_monitor.cpp と同一にしてあり、
// recorder/modlog.py の FPS_MONITOR_HZ_RE
// (`FpsMonitor:.*\(([\d.]+) Hz\)`)によるfps暴走検知がそのまま使える。
//
// th06cではロード中だけポーリングが1〜2Hzまで落ち、タイトル画面以降は描画フレームと
// 1:1の60Hzになる(フェーズ74で実測)。暴走検知は上振れのみを見るので影響しない。
DWORD WINAPI FpsMonitorThread(LPVOID) {
    LONG lastCount = g_pollCount;
    DWORD lastTick = GetTickCount();
    for (;;) {
        Sleep(5000);
        LONG current = g_pollCount;
        DWORD now = GetTickCount();
        LONG delta = current - lastCount;
        DWORD elapsedMs = now - lastTick;
        double hz = elapsedMs > 0 ? (delta * 1000.0 / elapsedMs) : 0.0;
        Log("FpsMonitor: %ld GetDeviceState calls in %lu ms (%.1f Hz)", (long)delta, elapsedMs, hz);
        lastCount = current;
        lastTick = now;
    }
    return 0;
}

// vk を holdFrames 回分のポーリングだけ押下状態にし、releaseFrames 回分離す。
// ミリ秒ではなくポーリング回数基準にしている理由は mods/common/dinput_hook.h と同じ。
void PressVKey(BYTE vk, unsigned int holdFrames = 1, unsigned int releaseFrames = 2,
               unsigned int timeoutMs = 2000) {
    if (FrameSyncD3D11Active()) {
        g_injectVk[vk] = 1;
        FrameSyncD3D11WaitPresentFrames(2);
        g_injectVk[vk] = 0;
        FrameSyncD3D11WaitPresentFrames(3);
        return;
    }
    LONG holdStart = g_pollCount;
    g_injectVk[vk] = 1;
    WaitFrames(holdStart, holdFrames, timeoutMs);

    LONG releaseStart = g_pollCount;
    g_injectVk[vk] = 0;
    WaitFrames(releaseStart, releaseFrames, timeoutMs);
}

// ---------------------------------------------------------------------------
// 起動時「解像度を選択してください」ダイアログの自動操作
// ---------------------------------------------------------------------------

void ToUtf8(const wchar_t *src, char *dst, int dstSize) {
    if (!WideCharToMultiByte(CP_UTF8, 0, src, -1, dst, dstSize, nullptr, nullptr)) {
        _snprintf_s(dst, dstSize, _TRUNCATE, "(conv failed)");
    }
}

struct DialogSearch {
    DWORD pid;
    HWND found;
};

BOOL CALLBACK FindDialogProc(HWND hwnd, LPARAM lparam) {
    auto *search = (DialogSearch *)lparam;
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid != search->pid) return TRUE;
    if (!IsWindowVisible(hwnd)) return TRUE;

    wchar_t cls[64] = {0};
    GetClassNameW(hwnd, cls, 64);
    if (wcscmp(cls, L"#32770") != 0) return TRUE;  // ダイアログの標準クラス

    search->found = hwnd;
    return FALSE;
}

BOOL CALLBACK LogChildProc(HWND hwnd, LPARAM) {
    wchar_t cls[64] = {0};
    wchar_t text[256] = {0};
    GetClassNameW(hwnd, cls, 64);
    GetWindowTextW(hwnd, text, 256);
    char clsU8[128], textU8[512];
    ToUtf8(cls, clsU8, sizeof(clsU8));
    ToUtf8(text, textU8, sizeof(textU8));
    Log("  child id=%d class=%s check=%ld text=\"%s\"", GetDlgCtrlID(hwnd), clsU8,
        (long)SendMessageW(hwnd, BM_GETCHECK, 0, 0), textU8);
    return TRUE;
}

// 「解像度を選択してください」ダイアログを閉じてゲーム本体を開始させる。
// ラジオの選択状態はth06.envに永続化されるが、どの環境でも同じ結果になるよう
// 明示的に「ウィンドウ 640x480」+VSyncありを選び直してから起動する。
bool DismissStartupDialog(unsigned int timeoutMs) {
    DWORD pid = GetCurrentProcessId();
    HWND dlg = nullptr;
    DWORD deadline = GetTickCount() + timeoutMs;
    while (GetTickCount() < deadline) {
        DialogSearch search{pid, nullptr};
        EnumWindows(FindDialogProc, (LPARAM)&search);
        if (search.found) {
            dlg = search.found;
            break;
        }
        Sleep(100);
    }
    if (!dlg) {
        Log("StartupDialog: ダイアログが見つかりませんでした(タイムアウト)");
        return false;
    }

    Log("StartupDialog: hwnd=%p — コントロール一覧:", (void *)dlg);
    EnumChildWindows(dlg, LogChildProc, 0);

    HWND radio = GetDlgItem(dlg, kIdWindow640x480);
    HWND vsync = GetDlgItem(dlg, kIdVSync);
    HWND start = GetDlgItem(dlg, kIdStartGame);
    if (!radio || !start) {
        Log("StartupDialog: 想定のコントロール(id=%d/%d)が見つかりません", kIdWindow640x480,
            kIdStartGame);
        return false;
    }

    // ラジオはグループ内で排他。CheckRadioButtonでウィンドウ640x480だけをONにする。
    CheckRadioButton(dlg, 200, 210, kIdWindow640x480);
    Log("StartupDialog: 「ウィンドウ 640x480」(id=%d) を選択しました", kIdWindow640x480);

    if (vsync && SendMessageW(vsync, BM_GETCHECK, 0, 0) != BST_CHECKED) {
        SendMessageW(vsync, BM_SETCHECK, BST_CHECKED, 0);
        Log("StartupDialog: 「VSyncを有効」(id=%d) をONにしました", kIdVSync);
    }

    Sleep(300);
    Log("StartupDialog: 「ゲーム起動」(id=%d) をクリックします", kIdStartGame);
    PostMessageW(dlg, WM_COMMAND, MAKEWPARAM(kIdStartGame, BN_CLICKED), (LPARAM)start);
    return true;
}

// ---------------------------------------------------------------------------
// スコア変数のRVA特定用プローブ(フェーズ74)
// ---------------------------------------------------------------------------
//
// th06cはオリジナルth06の完全な再実装であり、thpracのth06用RVAは一切流用できない。
// また64bitなので mods/common/score_probe_hook.* (32bit・固定RVA範囲の差分スキャン)
// もそのままでは使えないため、専用の「既知の値を全メモリから探す」プローブを用意する。
//
// 使い方:
//   TH06C_FIND_VALUE=<10進数>   探す32bit値(リプレイの記録スコア等)
//   TH06C_FIND_DELAY_MS=<int>   リプレイ再生開始からスキャンまでの待ち時間(既定 600000)
//
// リプレイ終了直後に「記録スコアと同じ値を持つアドレス」を列挙し、メインモジュール
// 内ならRVAとして出力する。異なるリプレイ(=異なる最終スコア)で2回実行し、
// 共通して現れるRVAがスコア変数である。

// メインモジュールの .data 領域(可変データが置かれる範囲)を返す。
// メニューカーソル位置のような小さな整数は、全メモリを対象にすると候補が膨大に
// なるため、この範囲に絞り込んで絞り込みスキャンを行う。
bool GetDataSectionRange(uintptr_t *outBegin, uintptr_t *outEnd) {
    auto base = (uintptr_t)GetModuleHandleW(nullptr);
    auto *dos = (IMAGE_DOS_HEADER *)base;
    auto *nt = (IMAGE_NT_HEADERS *)(base + dos->e_lfanew);
    auto *sec = IMAGE_FIRST_SECTION(nt);
    for (WORD i = 0; i < nt->FileHeader.NumberOfSections; i++, sec++) {
        if (memcmp(sec->Name, ".data", 5) == 0) {
            *outBegin = base + sec->VirtualAddress;
            *outEnd = *outBegin + sec->Misc.VirtualSize;
            return true;
        }
    }
    return false;
}

// メニューカーソル位置の変数を「値の遷移」で絞り込むためのプローブ(フェーズ74)。
//
// 1回目: .data内でDWORD値が expect と一致するアドレスを全部候補にする
// 2回目以降: 既存候補のうち値が expect と一致するものだけ残す
// これをカーソルを動かしながら繰り返すと、メニューカーソル位置だけが残る。
constexpr int kMaxMenuCandidates = 200000;
uintptr_t g_menuCandidates[kMaxMenuCandidates];
int g_menuCandidateCount = -1;  // -1 = 未初期化

void NarrowMenuCandidates(uint32_t expect) {
    uintptr_t begin = 0, end = 0;
    if (!GetDataSectionRange(&begin, &end)) {
        Log("[menu] .data セクションが見つかりません");
        return;
    }
    auto base = (uintptr_t)GetModuleHandleW(nullptr);

    if (g_menuCandidateCount < 0) {
        g_menuCandidateCount = 0;
        for (uintptr_t a = begin; a + 4 <= end; a += 4) {
            if (*(const uint32_t *)a != expect) continue;
            if (g_menuCandidateCount >= kMaxMenuCandidates) break;
            g_menuCandidates[g_menuCandidateCount++] = a;
        }
        Log("[menu] 初回スキャン(値=%u): 候補 %d 件", expect, g_menuCandidateCount);
        return;
    }

    int kept = 0;
    for (int i = 0; i < g_menuCandidateCount; i++) {
        if (*(const uint32_t *)g_menuCandidates[i] == expect) {
            g_menuCandidates[kept++] = g_menuCandidates[i];
        }
    }
    g_menuCandidateCount = kept;
    Log("[menu] 絞り込み(値=%u): 残り %d 件", expect, kept);
    if (kept > 0 && kept <= 20) {
        for (int i = 0; i < kept; i++) {
            Log("[menu]   候補 module+0x%08llX",
                (unsigned long long)(g_menuCandidates[i] - base));
        }
    }
}

void ScanForValue(uint32_t target) {
    HMODULE hExe = GetModuleHandleW(nullptr);
    auto base = (uintptr_t)hExe;
    Log("[find] モジュールベース=0x%p、値 %u (0x%X) を全コミット済みRWメモリから探索します",
        (void *)base, target, target);

    SYSTEM_INFO si{};
    GetSystemInfo(&si);
    auto addr = (uintptr_t)si.lpMinimumApplicationAddress;
    auto maxAddr = (uintptr_t)si.lpMaximumApplicationAddress;

    int hits = 0, regions = 0;
    MEMORY_BASIC_INFORMATION mbi{};
    while (addr < maxAddr && VirtualQuery((LPCVOID)addr, &mbi, sizeof(mbi)) == sizeof(mbi)) {
        auto regionBase = (uintptr_t)mbi.BaseAddress;
        SIZE_T regionSize = mbi.RegionSize;
        bool readable = mbi.State == MEM_COMMIT && !(mbi.Protect & PAGE_GUARD) &&
                        (mbi.Protect & (PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READWRITE |
                                        PAGE_EXECUTE_WRITECOPY));
        if (readable) {
            regions++;
            auto *p = (const uint32_t *)regionBase;
            SIZE_T count = regionSize / sizeof(uint32_t);
            for (SIZE_T i = 0; i < count; i++) {
                if (p[i] != target) continue;
                auto hitAddr = regionBase + i * sizeof(uint32_t);
                if (hitAddr >= base && hitAddr < base + 0x1000000) {
                    Log("[find] HIT module+0x%08llX (addr=0x%p)",
                        (unsigned long long)(hitAddr - base), (void *)hitAddr);
                } else {
                    Log("[find] HIT (module外) addr=0x%p region=0x%p size=0x%llX", (void *)hitAddr,
                        (void *)regionBase, (unsigned long long)regionSize);
                }
                if (++hits >= 200) {
                    Log("[find] ヒットが200件を超えたので打ち切ります");
                    return;
                }
            }
        }
        addr = regionBase + regionSize;
    }
    Log("[find] 探索完了: %d 件ヒット(%d リージョン走査)", hits, regions);
}

// ---------------------------------------------------------------------------
// スコア監視(score_monitor相当)
// ---------------------------------------------------------------------------
//
// フェーズ74のメモリ探索(ScanForValue)で、リプレイ終了時のゲーム内スコアと一致する
// アドレスが .data 内の隣接する2つのDWORDに見つかった。
//   module+0x003A3B4C
//   module+0x003A3B50
// どちらもリプレイ終了時に記録スコアと一致する。実測では 0x3A3B4C が
// 「内部スコア(即時に加算される真の値)」、0x3A3B50 が「画面表示用の
// 追いかけ値(集計アニメーション中は遅れる)」として振る舞う。
// デシンク判定には内部スコア側を使う。
//
// なおもう1つ見つかった module+0x00B63B74 はリプレイ開始前から記録スコアと
// 一致していたので、リプレイファイルから読み込んだ「記録スコア」の保持場所と
// 見られる(再生の正しさの検証には使えない)。
//
// th06cのスコアは画面表示値と等倍(オリジナルth06と同じ)。
constexpr uint32_t kScoreRva = 0x003A3B4C;
constexpr uint32_t kScoreDisplayRva = 0x003A3B50;

volatile bool g_scoreMonitorEnabled = false;

DWORD WINAPI ScoreMonitorThread(LPVOID) {
    auto base = (uintptr_t)GetModuleHandleW(nullptr);
    auto *score = (const volatile uint32_t *)(base + kScoreRva);
    auto *shown = (const volatile uint32_t *)(base + kScoreDisplayRva);
    uint32_t lastScore = 0xFFFFFFFFu, lastShown = 0xFFFFFFFFu;
    for (;;) {
        Sleep(1000);
        if (!g_scoreMonitorEnabled) continue;
        uint32_t s = *score, d = *shown;
        if (s == lastScore && d == lastShown) continue;
        lastScore = s;
        lastShown = d;
        FILETIME ft{};
        GetSystemTimeAsFileTime(&ft);
        ULARGE_INTEGER ul{};
        ul.LowPart = ft.dwLowDateTime;
        ul.HighPart = ft.dwHighDateTime;
        // FILETIME(100ns単位、1601年起点) -> Unix epoch ミリ秒
        unsigned long long epochMs = (ul.QuadPart - 116444736000000000ULL) / 10000ULL;
        // scripts/53_verify_replay_score.py が読む形式。stage/lives/graze は
        // th06cではRVA未特定のため -1 を出す(scripts/53はscoreのみを一致判定に使う)。
        Log("ScoreMonitor: score=%u stage=-1 lives=-1 graze=-1 epoch_ms=%llu displayed=%u", s,
            epochMs, d);
    }
    return 0;
}

// ---------------------------------------------------------------------------
// ゲームウィンドウの安定待ち
// ---------------------------------------------------------------------------

// mods/common/window_wait.cpp と同じ役割だが、th06c固有の事情に合わせた独自実装:
//   * 起動ダイアログ(クラス #32770、194x317)を「ゲームウィンドウ」と誤認しない
//   * dinput_hook.h(32bit系タイトル向けのGetDeviceStateフック)に依存しない
// ログの `WaitForStableWindow: stable` は scripts/25 が録画開始の合図として
// 待ち受けているマーカーなので、文言を変えないこと。
struct MainWindowCtx {
    DWORD pid;
    HWND result;
};

BOOL CALLBACK FindMainWindowProc(HWND hwnd, LPARAM lparam) {
    auto *ctx = (MainWindowCtx *)lparam;
    DWORD windowPid = 0;
    GetWindowThreadProcessId(hwnd, &windowPid);
    if (windowPid != ctx->pid) return TRUE;
    if (!IsWindowVisible(hwnd)) return TRUE;
    if (GetWindow(hwnd, GW_OWNER) != NULL) return TRUE;  // トップレベルのみ
    if (GetWindowTextLengthW(hwnd) == 0) return TRUE;    // タイトルバー付きのみ

    wchar_t cls[64] = {0};
    GetClassNameW(hwnd, cls, 64);
    if (wcscmp(cls, L"#32770") == 0) return TRUE;  // 起動ダイアログは対象外

    RECT rc{};
    if (GetClientRect(hwnd, &rc) && (rc.right - rc.left) < 320) return TRUE;

    ctx->result = hwnd;
    return FALSE;
}

HWND WaitForStableWindow(DWORD pid, unsigned int stableMs, unsigned int timeoutMs) {
    DWORD start = GetTickCount();
    HWND lastHwnd = nullptr;
    DWORD lastChangeTick = start;

    while (GetTickCount() - start < timeoutMs) {
        MainWindowCtx ctx{pid, nullptr};
        EnumWindows(FindMainWindowProc, (LPARAM)&ctx);
        HWND h = ctx.result;
        DWORD now = GetTickCount();

        if (h != lastHwnd) {
            if (lastHwnd == nullptr && h != nullptr) {
                Log("WaitForStableWindow: window appeared (hwnd=0x%p)", h);
            } else if (h != nullptr) {
                Log("WaitForStableWindow: window recreated (old=0x%p new=0x%p)", lastHwnd, h);
            }
            lastHwnd = h;
            lastChangeTick = now;
        } else if (h != nullptr && (now - lastChangeTick) >= stableMs) {
            Log("WaitForStableWindow: stable after %lu ms total", now - start);
            return h;
        }
        Sleep(100);
    }

    Log("WaitForStableWindow: TIMEOUT (last hwnd=0x%p)", lastHwnd);
    return lastHwnd;
}

// ---------------------------------------------------------------------------
// メインメニューのカーソル操作
// ---------------------------------------------------------------------------
//
// th06cのメインメニューはオリジナルth06から項目が増えており(Practice Start と
// License が追加、フェーズ74で実機確認)、次の9項目で固定:
//   0 Start / 1 Extra Start / 2 Practice Start / 3 Replay / 4 Score /
//   5 Music Room / 6 Option / 7 License / 8 Quit
//
// 項目自体はセーブデータの解放状況によらず常に9つ表示されるが、**未解放の項目は
// カーソルがスキップする**(Extra未解放なら 0 -> 2 と飛ぶ)。そのため「Down を
// 固定回数押す」実装はセーブデータの状態によって行き先が変わってしまう。
//
// そこでカーソル位置の変数(フェーズ74のmenuprobeで特定、下記RVA)を直接読み、
// "Replay" のインデックスに一致するまでDownを送る方式にしている。これなら
// Extra解放済み/未解放のどちらでも、また将来項目がスキップされる条件が増えても
// 正しく "Replay" に到達できる。
constexpr uint32_t kMenuIndexRva = 0x00B5C168;
constexpr uint32_t kMenuIndexReplay = 3;
constexpr int kMenuNavMaxPresses = 12;

uint32_t ReadMenuIndex() {
    auto base = (uintptr_t)GetModuleHandleW(nullptr);
    return *(const volatile uint32_t *)(base + kMenuIndexRva);
}

void ScaledSleep(DWORD ms) {
    if (FrameSyncD3D11Active()) FrameSyncD3D11SleepMs(ms);
    else Sleep(ms);
}

bool NavigateToReplay() {
    uint32_t idx = ReadMenuIndex();
    Log("Step 2: メニューカーソル位置=%u。'Replay'(index=%u)までDownを送ります", idx,
        kMenuIndexReplay);
    for (int i = 0; i < kMenuNavMaxPresses && idx != kMenuIndexReplay; i++) {
        PressVKey(VK_DOWN);
        ScaledSleep(250);
        uint32_t next = ReadMenuIndex();
        Log("  Down %d回目: index %u -> %u", i + 1, idx, next);
        if (next == idx) {
            Log("  WARNING: カーソルが動きませんでした");
        }
        idx = next;
    }
    if (idx != kMenuIndexReplay) {
        Log("ERROR: %d回Downを送ってもカーソルが 'Replay' に到達しませんでした(index=%u)",
            kMenuNavMaxPresses, idx);
        return false;
    }
    Log("  'Replay' を選択状態にしました(index=%u)", idx);
    return true;
}

// ---------------------------------------------------------------------------
// メインシーケンス
// ---------------------------------------------------------------------------

DWORD WINAPI AutoPlayThread(LPVOID) {
    Log("=== th06c_replay_autoplay: AutoPlayThread started ===");
    CreateThread(nullptr, 0, FpsMonitorThread, nullptr, 0, nullptr);
    CreateThread(nullptr, 0, ScoreMonitorThread, nullptr, 0, nullptr);

    if (!DismissStartupDialog(/*timeoutMs=*/60000)) {
        Log("ERROR: 起動ダイアログを閉じられませんでした。中断します");
        return 1;
    }

    if (!WaitForStableWindow(GetCurrentProcessId(), /*stableMs=*/800, /*timeoutMs=*/60000)) {
        Log("ERROR: ゲームウィンドウが出現しませんでした。中断します");
        return 1;
    }

    Log("入力ポーリングの開始を待ちます...");
    DWORD deadline = GetTickCount() + 60000;
    while (g_pollCount == 0 && GetTickCount() < deadline) Sleep(50);
    if (g_pollCount == 0) {
        Log("ERROR: 入力ポーリングが一度も観測されませんでした(kbState=%ld async=%ld)",
            (long)g_kbStateCalls, (long)g_asyncCalls);
        return 1;
    }
    Log("入力ポーリング開始を検出(kbState=%ld async=%ld)", (long)g_kbStateCalls,
        (long)g_asyncCalls);

    // 環境変数 TH06C_SEQ で切り分け用の縮退シーケンスを選べる(フェーズ74の調査用)。
    //   none      : ダイアログを閉じるだけ。放置してもデモが終わるのか確認する
    //   enter     : Enterを1回だけ。Enter注入が本当に効いているか確認する
    //   enterdown : Enterの5秒後にDownを1回。方向キー注入の可否を確認する
    char seq[32] = {0};
    GetEnvironmentVariableA("TH06C_SEQ", seq, sizeof(seq));
    if (seq[0]) Log("診断モード TH06C_SEQ=%s", seq);

    if (_stricmp(seq, "none") == 0) {
        Log("[diag] キー入力を一切行わず60秒待機します");
        Sleep(60000);
        Log("[diag] 待機終了");
        return 0;
    }
    if (_stricmp(seq, "enter") == 0) {
        Sleep(2000);
        Log("[diag] Enterを1回だけ押します");
        PressVKey(VK_RETURN);
        Sleep(30000);
        Log("[diag] 待機終了");
        return 0;
    }
    if (_stricmp(seq, "enterdown") == 0) {
        Sleep(2000);
        Log("[diag] Enter -> 5秒待機 -> Down 1回 -> 20秒待機");
        PressVKey(VK_RETURN);
        Sleep(5000);
        Log("[diag] Down を押します(VK_DOWNのみ)");
        PressVKey(VK_DOWN);
        Sleep(20000);
        Log("[diag] 待機終了");
        return 0;
    }
    // メニューカーソル位置の変数を絞り込むプローブ。メニューを表示した状態で
    // カーソルを1つずつ動かし、各時点で期待されるインデックスと一致し続ける
    // .data内のDWORDだけを残していく。Extra解放済みセーブデータで実行すること
    // (カーソルが 0,1,2,3,... と素直に進む前提のため)。
    if (_stricmp(seq, "menuprobe") == 0) {
        Sleep(2000);
        Log("[menu] Enter でメニューを表示します");
        PressVKey(VK_RETURN);
        Sleep(2500);
        // 値0(=カーソルが "Start")から始めると .data 内の未使用領域が全部候補に
        // なって上限に達してしまうため、Downを1回押して値1になった状態を初回
        // スキャンの基準にする。
        PressVKey(VK_DOWN);
        Sleep(600);
        NarrowMenuCandidates(1);
        for (uint32_t expect = 2; expect <= 6; expect++) {
            PressVKey(VK_DOWN);
            Sleep(600);
            NarrowMenuCandidates(expect);
            if (g_menuCandidateCount == 0) {
                Log("[menu] 候補がゼロになりました(インデックスの進み方が想定と違う可能性)");
                break;
            }
        }
        Sleep(3000);
        Log("[menu] プローブ終了");
        return 0;
    }

    Log("タイトルロゴのアニメーション用に2000ms待機します...");
    ScaledSleep(2000);

    Log("Step 1: Enter (デモ再生を抜けてメインメニューを表示)");
    PressVKey(VK_RETURN);
    ScaledSleep(FrameSyncD3D11Active() ? 1200 : 500);

    if (!NavigateToReplay()) {
        Log("ERROR: メインメニューで 'Replay' を選択できませんでした。中断します");
        return 1;
    }

    Log("Step 3: Enter ('Replay' を確定、リプレイ一覧へ)");
    PressVKey(VK_RETURN);
    ScaledSleep(2000);

    Log("Step 4: Enter (1番目のリプレイファイルを選択)");
    PressVKey(VK_RETURN);
    ScaledSleep(1000);

    Log("Step 5: Enter (リプレイ再生開始)");
    PressVKey(VK_RETURN);
    ScaledSleep(700);
    FrameSyncD3D11SetUnthrottled(true);

    // リプレイ再生が始まってから監視を開始する(メニュー滞在中の残留値を拾わないため)
    g_scoreMonitorEnabled = true;

    Log("=== th06c_replay_autoplay: sequence complete ===");

    char findValue[32] = {0};
    GetEnvironmentVariableA("TH06C_FIND_VALUE", findValue, sizeof(findValue));
    if (findValue[0]) {
        auto envInt = [](const char *name, unsigned long fallback) -> unsigned long {
            char buf[32] = {0};
            GetEnvironmentVariableA(name, buf, sizeof(buf));
            return buf[0] ? strtoul(buf, nullptr, 10) : fallback;
        };
        DWORD delayMs = (DWORD)envInt("TH06C_FIND_DELAY_MS", 600000);
        int repeat = (int)envInt("TH06C_FIND_REPEAT", 1);
        DWORD intervalMs = (DWORD)envInt("TH06C_FIND_INTERVAL_MS", 10000);
        auto target = (uint32_t)strtoul(findValue, nullptr, 10);
        Log("[find] %lu ms 後から %d 回、%lu ms 間隔でメモリ探索を行います", delayMs, repeat,
            intervalMs);
        Sleep(delayMs);
        for (int i = 0; i < repeat; i++) {
            Log("[find] --- スキャン %d/%d (経過 %lu ms) ---", i + 1, repeat,
                delayMs + i * intervalMs);
            ScanForValue(target);
            if (i + 1 < repeat) Sleep(intervalMs);
        }
    }
    return 0;
}

}  // namespace

BOOL APIENTRY DllMain(HMODULE hModule, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hModule);
        LogInit(hModule, "th06c_autoplay.log");
        Log("=== th06c_replay_autoplay DllMain: DLL_PROCESS_ATTACH ===");

        bool ok = HookIATEntry("KERNEL32.dll", "GetProcAddress", (void *)MyGetProcAddress,
                               (void **)&g_origGetProcAddress);
        Log("GetProcAddress IAT hook: %s", ok ? "OK" : "FAILED");

        bool okMap = HookIATEntry("USER32.dll", "MapVirtualKeyExW", (void *)MyMapVirtualKeyExW,
                                  (void **)&g_origMapVirtualKeyExW);
        Log("MapVirtualKeyExW IAT hook: %s", okMap ? "OK" : "FAILED");

        bool okCo = HookIATEntry("ole32.dll", "CoCreateInstance", (void *)MyCoCreateInstance,
                                 (void **)&g_origCoCreateInstance);
        Log("CoCreateInstance IAT hook: %s", okCo ? "OK" : "FAILED");
        // フレーム同期キャプチャまたは倍速録画(reports/90)
        if (!InstallFrameSyncD3D11(64)) {
            InstallSpeedHackHook();
            InstallWasapiHook(1.0);
        }

        CreateThread(nullptr, 0, AutoPlayThread, nullptr, 0, nullptr);
    }
    return TRUE;
}
