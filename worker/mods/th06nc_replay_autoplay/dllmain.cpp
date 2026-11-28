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
//   * メニューカーソル位置のRVAは未特定のため、固定3回のDownでフォールバックする。
//   * スコアのRVAは特定済み(kScoreRva = 0x0053D3E8、内部即時値。th06cとは
//     内部値/表示値の前後関係が逆)。**ゲームのバージョンごとに変わる**
//     (ver 1.0.6で0x004F2798から移動、docs/reports/2026-09-28-th06nc-v1.0.6-
//     update-verification.md)。
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
#include <cstring>

#include "audio/wasapi.h"
#include "autoplay/dxlib_common.h"
#include "autoplay/menu_script.h"
#include "autoplay/window_wait.h"
#include "clock/speed_hack.h"
#include "core/log.h"
#include "core/pe_iat.h"
#include "core/runtime_config.h"
#include "core/time_scale.h"
#include "input/dxlib_input.h"
#include "monitor/score_monitor.h"
#include "present/capture/d3d11_readback.h"
#include "present/capture/frame_sync.h"
#include "texture/d3d11_bc7.h"

using namespace autoplay;
using autoplay::dxlib::g_pollCount;
using autoplay::dxlib::PressVKey;

namespace {

// ---------------------------------------------------------------------------
// 起動時ダイアログの有無チェック(th06ncでは出ないはずの確認用)
// ---------------------------------------------------------------------------
//
// th06cは起動のたびに「解像度を選択してください」モーダルダイアログを出すが、
// th06ncにはこのダイアログが無い(touhou-recorder reports/78 §4で実機確認)。
// 将来ゲーム側の更新でダイアログが復活した場合に気づけるよう、起動直後に
// ダイアログクラス(#32770)のウィンドウが出ていないかだけ確認してログに残す。

void WarnIfStartupDialogPresent(unsigned int watchMs) {
    DWORD pid = GetCurrentProcessId();
    DWORD deadline = GetTickCount() + watchMs;
    while (GetTickCount() < deadline) {
        HWND found = dxlib::FindStartupDialog(pid);
        if (found) {
            Log("WARNING: 想定外の起動ダイアログ(#32770, hwnd=%p)を検出しました。"
                "th06c版の実装(DismissStartupDialog)の移植が必要かもしれません",
                (void *)found);
            return;
        }
        Sleep(100);
    }
    Log("StartupDialog: %u ms 監視しましたがダイアログは出ませんでした(想定どおり)", watchMs);
}

// ---------------------------------------------------------------------------
// メインメニューのカーソル操作
// ---------------------------------------------------------------------------
//
// th06ncのメインメニューはth06cと同じ9項目構成と見られるが、カーソル位置の
// RVAは未特定(touhou-recorder reports/78)。特定するまでは
// 固定3回のDownでフォールバックする
// (未解放セーブデータの状態でも "Replay" に到達することを実機確認済み)。
bool NavigateToReplayByFixedDowns() {
    const int downs = 3;
    LogStep(2, "カーソル位置RVAが未特定のため Down を固定 %d 回送ります", downs);
    for (int i = 0; i < downs; i++) {
        PressVKey(VK_DOWN);
        time_scale::MenuSleep(250);
    }
    return true;
}

void StartTh06ncScoreMonitor() {
    // リプレイずれ判定用のスコア監視(Issue #103)。RVA未特定時は
    // StartScoreMonitorThread()自体がスレッドを起動しない設計なので、
    // ここで即returnする実装をわざわざ書く必要はない(score_monitor.cpp参照。
    // touhou-recorder側の独自実装ではreturnによるDLL_THREAD_DETACH競合を
    // 避けるためSleepループへ迂回させていたが、共通実装は最初からスレッドを
    // 作らないため同じ問題は起きない)。ステージ番号・残機・グレイズのRVAは
    // 未特定のためwidth=0で無効化する(worker/recording/modlog.pyの
    // GAME_SCORE_MULTIPLIERSにth06nc=1を登録済み)。
    ScoreMonitorConfig sm;
    // th06ncとth06cとは内部値/表示値の前後関係が逆で、0x0053D3E8が
    // 即時に加算される内部スコア、0x0053D3E0がそれを追いかける画面表示用の
    // 値(touhou-recorder reports/79で実機確認した関係がver 1.0.6でも同じ)。
    // デシンク判定には内部スコア側を使う。ver 1.0.6より前のexeでは
    // 0x004F2798/0x004F2790だった——ゲーム更新でexeが再ビルドされると
    // ずれるので、更新時は`verify-game-update` skillで必ず再確認すること。
    sm.baseRva = 0x0053D3E8;
    sm.baseIsPointer = false;
    sm.scoreOffset = 0;
    sm.scoreWidth = 4;
    sm.intervalMs = 1000;
    StartScoreMonitorThread(sm);
}

// ---------------------------------------------------------------------------
// メインシーケンス
// ---------------------------------------------------------------------------

void PressMenuKey(Key key) {
    switch (key) {
        case Key::kDown: PressVKey(VK_DOWN); break;
        case Key::kRight: PressVKey(VK_RIGHT); break;
        case Key::kReturn: PressVKey(VK_RETURN); break;
    }
}

// Step 2(Replay へカーソルを動かす)。`Step 2:` 行は NavigateToReplayByFixedDowns が出す。
bool NavigateStep(int /*step*/) {
    if (!NavigateToReplayByFixedDowns()) {
        Log("ERROR: メインメニューで 'Replay' を選択できませんでした。中断します");
        return false;
    }
    return true;
}

// メニュー操作(Step 1〜5)。待ちは autoplay/menu_script が MenuSleep で行う。
const MenuStep kMenu[] = {
    {.key = Key::kReturn, .waitMs = 500, .waitMsFrameSync = 1200,
     .label = "Enter (デモ再生を抜けてメインメニューを表示)"},
    {.custom = NavigateStep},
    {.key = Key::kReturn, .waitMs = 2000, .label = "Enter ('Replay' を確定、リプレイ一覧へ)"},
    {.key = Key::kReturn, .waitMs = 1000, .label = "Enter (1番目のリプレイファイルを選択)"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (リプレイ再生開始)"},
};

DWORD WINAPI AutoPlayThread(LPVOID) {
    // 【重要】ここから先、ゲーム本体の初期化完了(入力ポーリング開始)が
    // 確認できるまでは Log()・CreateThread()・USER32のウィンドウ列挙の
    // いずれも呼んではならない(ファイル冒頭のコメント参照)。
    // (Config() はDllMainで読み終えた値を返すだけでロックを取らない)
    DWORD deadline = GetTickCount() + 120000;
    while (g_pollCount == 0 && GetTickCount() < deadline) Sleep(50);

    // ここから先はロックを取っても安全。
    Log("=== th06nc_replay_autoplay: AutoPlayThread started ===");
    if (g_pollCount == 0) {
        Log("ERROR: 入力ポーリングが一度も観測されませんでした");
        return 1;
    }
    Log("入力ポーリング開始を検出");
    if (frame_sync::Active()) StartTh06ncScoreMonitor();

    // th06ncには起動ダイアログが無い。復活していないかの確認だけ行う(1秒)。
    WarnIfStartupDialogPresent(/*watchMs=*/1000);

    if (!WaitForStableWindow(GetCurrentProcessId(), /*stableMs=*/800,
                             /*timeoutMs=*/60000, WindowFilter::kDxlib)) {
        Log("ERROR: ゲームウィンドウが出現しませんでした。中断します");
        return 1;
    }

    // th06ncはタイトル画面が表示されてから4秒ほどでキー入力を受け付けるように
    // なる(ユーザー提供情報)。余裕を見て5秒待つ。
    const DWORD titleWaitMs = frame_sync::Active() ? 7000 : 5000;
    Log("タイトル画面のキー入力受付開始を待ちます(%lums x MENU_SCALE=%.2f)...",
        (unsigned long)titleWaitMs, time_scale::Menu());
    time_scale::MenuSleep(titleWaitMs);

    return RunMenuScript("th06nc", kMenu, /*firstStep=*/1, PressMenuKey) ? 0 : 1;
}

}  // namespace

BOOL APIENTRY DllMain(HMODULE hModule, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hModule);
        LogInit(hModule, "th06nc_autoplay.log");
        InitRuntimeConfig();
        Log("=== th06nc_replay_autoplay DllMain: DLL_PROCESS_ATTACH ===");

        const bool fs = InstallFrameSyncD3D11(64);
        // CPU描画(Xvfb+wined3d+llvmpipe)のときだけBC7テクスチャをRGBA8へ展開する
        // (`D3D11_DECODE_BC7=1`、touhou-recorder reports/96)。DXライブラリはd3d11も動的に取得する。
        // 環境変数が無ければ元の関数をそのまま返すので、GPU描画には影響しない。
        procaddr::Override("D3D11CreateDevice", WrapD3D11CreateDeviceForBc7);
        procaddr::Override("D3D11CreateDeviceAndSwapChain", WrapD3D11CreateDeviceAndSwapChainForBc7);
        // 入力・時刻・音声のGetProcAddress横取り(autoplay/dxlib_common.h)。
        dxlib::InstallHooks(dxlib::Options{/*hookAsyncKeyState=*/true});
        if (!fs) {
            // 倍速録画(Issue #288): QPC偽装とWASAPIのレート偽装・同期マーカーの準備。
            // FPS_LIMIT_TARGET_HZ未設定(等倍)ならレートは変えない。
            InstallSpeedHackHook();
            InstallWasapiHook();
            StartTh06ncScoreMonitor();
        }

        CreateThread(nullptr, 0, AutoPlayThread, nullptr, 0, nullptr);
    }
    return TRUE;
}
