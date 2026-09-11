// th06c(東方紅魔郷: Classic)リプレイ自動再生MOD。
//
// 他タイトルとの構造的な違い(touhou-recorder reports/74・75で判明):
//   * th06c.exe は PE32+ (x86-64)。MOD・injectorとも64bitでビルドする(build-mods skill参照)。
//   * 入力ポーリングが DirectInput でも「IATの」GetKeyboardState でもない。th06c.exe
//     (DXライブラリ系エンジン)は User32.dll を LoadLibrary + GetProcAddress で動的に
//     解決してから GetKeyboardState を呼ぶため、IATフックでは一切引っかからない。
//     そこで KERNEL32!GetProcAddress の方をIATフックし、入力APIの解決要求に対して
//     自前の関数ポインタを返す方式にしている。
//   * 起動時に「解像度を選択してください」モーダルダイアログ(USER32!DialogBoxIndirectParamW)
//     が毎回表示され、これを閉じないとゲーム本体が始まらない。プロセス内のワーカースレッドから
//     ダイアログのコントロールを直接操作して閉じる。コントロールIDは実機列挙済み:
//       id=206..210 ウィンドウ(2560x1920/1920x1440/1280x960/960x720/640x480)
//       id=400      VSyncを有効(チェックボックス)
//       id=1        ゲーム起動(IDOK)
//   * ダイアログを閉じた直後のウィンドウ検出は mods/common/window_wait.cpp
//     (DirectInputのGetDeviceStateフックに依存)を使えないため、起動ダイアログ
//     (クラス #32770)を除外する独自実装を用意する。
//   * Steamworks API が初期化できないと即 exit(255) するため、th06c_steam_stub の
//     スタブ steam_api64.dll をタイトル資産側に同梱して差し替える(録画時の対応は不要)。
//   * メインメニューは項目数がセーブデータの解放状況で変わる(Extra解放済みなら9項目
//     全部が個別に選べるが、未解放だと "Extra Start" がスキップされる)ため、固定回数の
//     Downではなく、メニューカーソル位置を保持する変数(kMenuIndexRva)を読みながら
//     "Replay"(index=3)に到達するまでDownを送る。
//
// メニュー操作シーケンス:
//   起動ダイアログを閉じる -> ウィンドウ安定待ち -> 入力ポーリング開始を待つ ->
//   タイトルロゴ演出待ち(2000ms) -> Enter(メニュー表示) ->
//   カーソル追従でDown(Replayを選択) -> Enter(Replay確定) ->
//   Enter(1番目のリプレイファイルを選択) -> Enter(再生開始)

#include <windows.h>

#include <cstdint>
#include <cstring>

#include "../common/logging.h"
#include "../common/score_monitor.h"

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
// IATフックの共通処理(KERNEL32!GetProcAddress)
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
// キー入力注入(GetProcAddressフック経由)
// ---------------------------------------------------------------------------

typedef BOOL(WINAPI *GetKeyboardState_t)(PBYTE);
typedef FARPROC(WINAPI *GetProcAddress_t)(HMODULE, LPCSTR);

GetKeyboardState_t g_origGetKeyboardState = nullptr;
GetProcAddress_t g_origGetProcAddress = nullptr;

// 「1フレーム分の入力」の基準にするポーリング回数(GetKeyboardStateの呼び出し回数)。
volatile LONG g_pollCount = 0;
volatile BYTE g_injectVk[256] = {0};

BOOL WINAPI MyGetKeyboardState(PBYTE lpKeyState) {
    BOOL ok = g_origGetKeyboardState ? g_origGetKeyboardState(lpKeyState) : FALSE;
    InterlockedIncrement(&g_pollCount);
    if (ok && lpKeyState) {
        for (int i = 0; i < 256; i++) {
            if (g_injectVk[i]) lpKeyState[i] |= 0x80;
        }
    }
    return ok;
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
// th06cはロード中だけポーリングが1〜2Hzまで落ち、タイトル画面以降は描画フレームと
// 1:1の60Hzになる(touhou-recorder reports/74で実測)。出力形式は
// mods/common/fps_monitor.cpp と揃えてあるが、th06cはDirectInputのGetDeviceStateフック
// (g_hookCallCount)に依存しない独自のポーリングカウンタ(g_pollCount)を使うため、
// 共通実装は使わずここで直接実装する。
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
void PressVKey(BYTE vk, unsigned int holdFrames = 1, unsigned int releaseFrames = 2,
               unsigned int timeoutMs = 2000) {
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
// ゲームウィンドウの安定待ち
// ---------------------------------------------------------------------------

// mods/common/window_wait.cpp と同じ役割だが、th06c固有の事情に合わせた独自実装:
//   * 起動ダイアログ(クラス #32770、194x317)を「ゲームウィンドウ」と誤認しない
//   * dinput_hook.h(32bit系タイトル向けのGetDeviceStateフック)に依存しない
// ログの `WaitForStableWindow: stable` は録画パイプライン(recording/pipeline.py)が
// 録画開始の合図として待ち受けているマーカーなので、文言を変えないこと。
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
// th06cのメインメニューは次の9項目で固定:
//   0 Start / 1 Extra Start / 2 Practice Start / 3 Replay / 4 Score /
//   5 Music Room / 6 Option / 7 License / 8 Quit
//
// 項目自体はセーブデータの解放状況によらず常に9つ表示されるが、**未解放の項目は
// カーソルがスキップする**(Extra未解放なら 0 -> 2 と飛ぶ、touhou-recorder reports/75)。
// そのため「Down を固定回数押す」実装はセーブデータの状態によって行き先が変わって
// しまう。そこでカーソル位置の変数(下記RVA、touhou-recorder reports/75のmenuprobeで
// 特定)を直接読み、"Replay" のインデックスに一致するまでDownを送る方式にしている。
constexpr uint32_t kMenuIndexRva = 0x00B5C168;
constexpr uint32_t kMenuIndexReplay = 3;
constexpr int kMenuNavMaxPresses = 12;

uint32_t ReadMenuIndex() {
    auto base = (uintptr_t)GetModuleHandleW(nullptr);
    return *(const volatile uint32_t *)(base + kMenuIndexRva);
}

bool NavigateToReplay() {
    uint32_t idx = ReadMenuIndex();
    Log("Step 2: メニューカーソル位置=%u。'Replay'(index=%u)までDownを送ります", idx,
        kMenuIndexReplay);
    for (int i = 0; i < kMenuNavMaxPresses && idx != kMenuIndexReplay; i++) {
        PressVKey(VK_DOWN);
        Sleep(250);
        uint32_t next = ReadMenuIndex();
        Log("  Down %d回目: index %u -> %u", i + 1, idx, next);
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
        Log("ERROR: 入力ポーリングが一度も観測されませんでした");
        return 1;
    }
    Log("入力ポーリング開始を検出");

    Log("タイトルロゴのアニメーション用に2000ms待機します...");
    Sleep(2000);

    Log("Step 1: Enter (デモ再生を抜けてメインメニューを表示)");
    PressVKey(VK_RETURN);
    Sleep(500);

    if (!NavigateToReplay()) {
        Log("ERROR: メインメニューで 'Replay' を選択できませんでした。中断します");
        return 1;
    }

    Log("Step 3: Enter ('Replay' を確定、リプレイ一覧へ)");
    PressVKey(VK_RETURN);
    Sleep(2000);

    Log("Step 4: Enter (1番目のリプレイファイルを選択)");
    PressVKey(VK_RETURN);
    Sleep(1000);

    Log("Step 5: Enter (リプレイ再生開始)");
    PressVKey(VK_RETURN);
    Sleep(700);

    Log("=== th06c_replay_autoplay: sequence complete ===");
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

        // リプレイずれ判定用のスコア監視(Issue #103)。th06cはオリジナルth06の完全な
        // 再実装であり、thpracのth06用RVAは一切流用できない。touhou-recorder reports/75の
        // メモリ探索で特定した内部スコア(即時加算される真の値、画面表示用の追いかけ値
        // ではない方)を使う。スコアの倍率は等倍(th06と同じ)。ステージ番号・残機・
        // グレイズのRVAは未特定のため width=0 で無効化する(worker/recording/modlog.pyの
        // GAME_SCORE_MULTIPLIERSにth06c=1を登録済み)。
        {
            ScoreMonitorConfig sm;
            sm.baseRva = 0x003A3B4C;
            sm.baseIsPointer = false;
            sm.scoreOffset = 0;
            sm.scoreWidth = 4;
            sm.intervalMs = 1000;
            StartScoreMonitorThread(sm);
        }

        CreateThread(nullptr, 0, AutoPlayThread, nullptr, 0, nullptr);
    }
    return TRUE;
}
