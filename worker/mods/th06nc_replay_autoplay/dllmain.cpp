// th06nc(東方紅魔郷: New Classic)リプレイ自動再生MOD。
//
// th06c(東方紅魔郷: Classic)用MOD(../th06c_replay_autoplay/dllmain.cpp)からの派生。
// th06ncはth06cと同じDXライブラリ系エンジンの64bitバイナリなので、基本構造
// (Steamworks APIスタブ併用 + GetProcAddressフックによる入力注入)はそのまま
// 流用できる(touhou-recorder reports/78)。th06cとの主な差分:
//
//   * **起動時の「解像度を選択してください」ダイアログが無い**。th06ncは
//     th06.env の内容どおりのウィンドウを直接作る(byte[5]の値は
//     `worker/record_th06nc.py`が起動前に書き換える)。DismissStartupDialog()
//     相当の処理は不要で、代わりに「ダイアログが復活していないか」を1秒だけ
//     監視する WarnIfStartupDialogPresent() のみ行う。
//   * **GPU描画が必須**。Xvfb+wined3d+llvmpipeのソフトウェア描画では
//     1280x720で約9fpsしか出ず60fpsに遠く届かない。録画は
//     Xorg+NVIDIA GRIDドライバ+DXVKのGPU描画面で行う(`worker/recording/
//     gpu_display.py`)。
//   * Steam AppIDは4763590(th06cは4771400)。スタブは共通の設計だが
//     AppID差分のため`th06nc_steam_stub/`として別ビルドする。
//   * メニューカーソル位置のRVAは未特定のため、環境変数`TH06NC_MENU_DOWNS`
//     (既定3回)による固定回数のDownでフォールバックする。
//   * スコアのRVAは特定済み(kScoreRva = 0x004F2798、内部即時値。th06cとは
//     内部値/表示値の前後関係が逆)。
//
// メニュー操作シーケンス:
//   タイトル画面(ロード後5秒ほどでキー入力可能) -> Enter(メニュー表示) ->
//   Down x N で "Replay" まで移動 -> Enter(リプレイ一覧へ) ->
//   Enter(1番目のリプレイを選択) -> Enter(再生開始)
//
// 【最重要の地雷】DllMainから生やしたスレッドが、ゲーム本体の初期化完了前に
// USER32のウィンドウ列挙API(EnumWindows等)を呼ぶとローダーロックのデッドロックを
// 起こす(touhou-recorder reports/78 §10.1で実機確認)。th06ncのゲーム本体は
// 起動直後、ローダーロックを保持したまま winmm/xinput 等のDLLを順に読み込むため、
// この最中に本スレッドから EnumWindows を呼ぶと「EnumWindows側がwinex11.drv等の
// ロードでローダーロックを待つ」×「ゲーム本体側がUSER32側のロックを待つ」の
// ロック反転が起きる。ゲーム本体の初期化完了は入力ポーリング(GetKeyboardState)の
// 開始で判定できる(メモリ上のカウンタを読むだけでロックを取らない)。
// **ウィンドウ関連のUSER32呼び出しは、入力ポーリング開始を検出するまで
// 一切行ってはならない**(Log()自体もファイルI/O経由でロックを取りうるため、
// 検出前はログ出力も避ける)。

#include <windows.h>

#include <cstdint>
#include <cstdlib>
#include <cstring>

#include "../common/logging.h"
#include "../common/score_monitor.h"

using namespace autoplay;

namespace {

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
typedef SHORT(WINAPI *GetAsyncKeyState_t)(int);
typedef FARPROC(WINAPI *GetProcAddress_t)(HMODULE, LPCSTR);

GetKeyboardState_t g_origGetKeyboardState = nullptr;
GetAsyncKeyState_t g_origGetAsyncKeyState = nullptr;
GetProcAddress_t g_origGetProcAddress = nullptr;

// 「1フレーム分の入力」の基準にするポーリング回数。ゲームが実際に使っている
// 経路(GetKeyboardState / GetAsyncKeyStateのどちら、あるいは両方)の呼び出し回数を
// 数える。実機ではGetKeyboardStateのみが使われる(reports/78)が、両方をフックして
// おくことで将来的な挙動変化にも耐える。
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

SHORT WINAPI MyGetAsyncKeyState(int vKey) {
    SHORT result = g_origGetAsyncKeyState ? g_origGetAsyncKeyState(vKey) : 0;
    InterlockedIncrement(&g_pollCount);
    if (vKey >= 0 && vKey < 256 && g_injectVk[vKey]) {
        result |= (SHORT)0x8001;
    }
    return result;
}

FARPROC WINAPI MyGetProcAddress(HMODULE hModule, LPCSTR lpProcName) {
    FARPROC real = g_origGetProcAddress(hModule, lpProcName);

    // 序数指定(HIWORDが0)の場合は名前を持たないのでそのまま返す
    if (!lpProcName || ((ULONG_PTR)lpProcName >> 16) == 0) return real;

    if (strcmp(lpProcName, "GetKeyboardState") == 0) {
        if (!g_origGetKeyboardState) {
            g_origGetKeyboardState = (GetKeyboardState_t)real;
        }
        return (FARPROC)MyGetKeyboardState;
    }
    if (strcmp(lpProcName, "GetAsyncKeyState") == 0) {
        if (!g_origGetAsyncKeyState) {
            g_origGetAsyncKeyState = (GetAsyncKeyState_t)real;
        }
        return (FARPROC)MyGetAsyncKeyState;
    }
    return real;
}

// メニュー操作の待ち時間スケール(環境変数 TH06NC_TIME_SCALE、既定1.0)。
//
// PressVKeyはポーリング回数(=描画フレーム)基準なのでfpsに依存しないが、
// 「Enterを押してから画面遷移アニメーションが終わるまで」のような待ちは
// Sleep()によるウォールクロック待ちなので、fpsが落ちた環境ではそのままだと
// 短すぎて次のキーを取りこぼす。GPUが使えないローカル環境での動作確認
// (llvmpipeで1280x720時9fps程度、touhou-recorder reports/78 §5)向けに、
// TH06NC_TIME_SCALE=7 のように指定して待ちを引き延ばせるようにしてある。
// 本番(GPU描画、60fps)では未指定=1.0のままでよい。
double GetTimeScale() {
    static double cached = -1.0;
    if (cached < 0.0) {
        char buf[32] = {0};
        GetEnvironmentVariableA("TH06NC_TIME_SCALE", buf, sizeof(buf));
        cached = buf[0] ? atof(buf) : 1.0;
        if (cached <= 0.0) cached = 1.0;
    }
    return cached;
}

void SleepScaled(DWORD ms) { Sleep((DWORD)(ms * GetTimeScale())); }

// g_pollCount が start から frames 回進むまで待つ
void WaitFrames(LONG start, unsigned int frames, unsigned int timeoutMs) {
    DWORD deadline = GetTickCount() + timeoutMs;
    while ((LONG)(g_pollCount - start) < (LONG)frames) {
        if (GetTickCount() > deadline) return;
        Sleep(1);
    }
}

// 入力ポーリングの実効レート(=実効描画fps相当)を一定間隔でログし続ける常駐スレッド。
// 出力形式は mods/common/fps_monitor.cpp と揃えてある。
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
// 起動時ダイアログの有無チェック(th06ncでは出ないはずの確認用)
// ---------------------------------------------------------------------------
//
// th06cは起動のたびに「解像度を選択してください」モーダルダイアログを出すが、
// th06ncにはこのダイアログが無い(touhou-recorder reports/78 §4で実機確認)。
// 将来ゲーム側の更新でダイアログが復活した場合に気づけるよう、起動直後に
// ダイアログクラス(#32770)のウィンドウが出ていないかだけ確認してログに残す。

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

void WarnIfStartupDialogPresent(unsigned int watchMs) {
    DWORD pid = GetCurrentProcessId();
    DWORD deadline = GetTickCount() + watchMs;
    while (GetTickCount() < deadline) {
        DialogSearch search{pid, nullptr};
        EnumWindows(FindDialogProc, (LPARAM)&search);
        if (search.found) {
            Log("WARNING: 想定外の起動ダイアログ(#32770, hwnd=%p)を検出しました。"
                "th06c版の実装(DismissStartupDialog)の移植が必要かもしれません",
                (void *)search.found);
            return;
        }
        Sleep(100);
    }
    Log("StartupDialog: %u ms 監視しましたがダイアログは出ませんでした(想定どおり)", watchMs);
}

// ---------------------------------------------------------------------------
// ゲームウィンドウの安定待ち
// ---------------------------------------------------------------------------

// mods/common/window_wait.cpp と同じ役割だが、th06c/th06nc固有の事情に合わせた
// 独自実装(起動ダイアログを「ゲームウィンドウ」と誤認しない、dinput_hook.hに
// 依存しない)。ログの `WaitForStableWindow: stable` は
// `worker/recording/pipeline.py` が録画開始の合図として待ち受けている
// マーカーなので、文言を変えないこと。
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
// th06ncのメインメニューはth06cと同じ9項目構成と見られるが、カーソル位置の
// RVAは未特定(touhou-recorder reports/78)。特定するまでは環境変数
// TH06NC_MENU_DOWNS(既定3回)による固定回数のDownでフォールバックする
// (未解放セーブデータの状態でも "Replay" に到達することを実機確認済み)。
bool NavigateToReplayByFixedDowns() {
    char buf[16] = {0};
    GetEnvironmentVariableA("TH06NC_MENU_DOWNS", buf, sizeof(buf));
    int downs = buf[0] ? atoi(buf) : 3;
    Log("Step 2: カーソル位置RVAが未特定のため Down を固定 %d 回送ります", downs);
    for (int i = 0; i < downs; i++) {
        PressVKey(VK_DOWN);
        SleepScaled(250);
    }
    return true;
}

// ---------------------------------------------------------------------------
// メインシーケンス
// ---------------------------------------------------------------------------

DWORD WINAPI AutoPlayThread(LPVOID) {
    // 【重要】ここから先、ゲーム本体の初期化完了(入力ポーリング開始)が
    // 確認できるまでは Log()・CreateThread()・USER32のウィンドウ列挙の
    // いずれも呼んではならない(ファイル冒頭のコメント参照)。
    DWORD deadline = GetTickCount() + 120000;
    while (g_pollCount == 0 && GetTickCount() < deadline) Sleep(50);

    // ここから先はロックを取っても安全。
    Log("=== th06nc_replay_autoplay: AutoPlayThread started ===");
    if (g_pollCount == 0) {
        Log("ERROR: 入力ポーリングが一度も観測されませんでした");
        return 1;
    }
    Log("入力ポーリング開始を検出");

    CreateThread(nullptr, 0, FpsMonitorThread, nullptr, 0, nullptr);

    // th06ncには起動ダイアログが無い。復活していないかの確認だけ行う(1秒)。
    WarnIfStartupDialogPresent(/*watchMs=*/1000);

    if (!WaitForStableWindow(GetCurrentProcessId(), /*stableMs=*/800, /*timeoutMs=*/60000)) {
        Log("ERROR: ゲームウィンドウが出現しませんでした。中断します");
        return 1;
    }

    // th06ncはタイトル画面が表示されてから4秒ほどでキー入力を受け付けるように
    // なる(ユーザー提供情報)。余裕を見て5秒待つ。
    Log("タイトル画面のキー入力受付開始を待ちます(5000ms x TIME_SCALE=%.1f)...", GetTimeScale());
    SleepScaled(5000);

    Log("Step 1: Enter (デモ再生を抜けてメインメニューを表示)");
    PressVKey(VK_RETURN);
    SleepScaled(500);

    if (!NavigateToReplayByFixedDowns()) {
        Log("ERROR: メインメニューで 'Replay' を選択できませんでした。中断します");
        return 1;
    }

    Log("Step 3: Enter ('Replay' を確定、リプレイ一覧へ)");
    PressVKey(VK_RETURN);
    SleepScaled(2000);

    Log("Step 4: Enter (1番目のリプレイファイルを選択)");
    PressVKey(VK_RETURN);
    SleepScaled(1000);

    Log("Step 5: Enter (リプレイ再生開始)");
    PressVKey(VK_RETURN);
    SleepScaled(700);

    Log("=== th06nc_replay_autoplay: sequence complete ===");
    return 0;
}

}  // namespace

BOOL APIENTRY DllMain(HMODULE hModule, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hModule);
        LogInit(hModule, "th06nc_autoplay.log");
        Log("=== th06nc_replay_autoplay DllMain: DLL_PROCESS_ATTACH ===");

        bool ok = HookIATEntry("KERNEL32.dll", "GetProcAddress", (void *)MyGetProcAddress,
                               (void **)&g_origGetProcAddress);
        Log("GetProcAddress IAT hook: %s", ok ? "OK" : "FAILED");

        // リプレイずれ判定用のスコア監視(Issue #103)。RVA未特定時は
        // StartScoreMonitorThread()自体がスレッドを起動しない設計なので、
        // ここで即returnする実装をわざわざ書く必要はない(score_monitor.cpp参照。
        // touhou-recorder側の独自実装ではreturnによるDLL_THREAD_DETACH競合を
        // 避けるためSleepループへ迂回させていたが、共通実装は最初からスレッドを
        // 作らないため同じ問題は起きない)。ステージ番号・残機・グレイズのRVAは
        // 未特定のためwidth=0で無効化する(worker/recording/modlog.pyの
        // GAME_SCORE_MULTIPLIERSにth06nc=1を登録済み)。
        {
            ScoreMonitorConfig sm;
            // th06ncとth06cとは内部値/表示値の前後関係が逆で、0x004F2798が
            // 即時に加算される内部スコア、0x004F2790がそれを追いかける画面表示用の
            // 値(touhou-recorder reports/79で実機確認)。デシンク判定には
            // 内部スコア側を使う。
            sm.baseRva = 0x004F2798;
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
