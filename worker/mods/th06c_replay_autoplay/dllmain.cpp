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
//   * ダイアログを閉じた直後のウィンドウ検出では、起動ダイアログ(クラス #32770)を
//     ゲームウィンドウと誤認しないよう WindowFilter::kDxlib を使う(autoplay/window_wait.h)。
//   * th06ncと共通の部分(GetProcAddressの横取り・入力の注入・音声のフック)は
//     autoplay/dxlib_common.h・input/dxlib_input.h にある。
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

#include "audio/wasapi.h"
#include "autoplay/dxlib_common.h"
#include "autoplay/window_wait.h"
#include "clock/speed_hack.h"
#include "core/log.h"
#include "core/runtime_config.h"
#include "core/time_scale.h"
#include "input/dxlib_input.h"
#include "monitor/score_monitor.h"
#include "present/capture/d3d11_readback.h"
#include "present/capture/frame_sync.h"

using namespace autoplay;
using autoplay::dxlib::g_pollCount;
using autoplay::dxlib::PressVKey;

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
// 起動時「解像度を選択してください」ダイアログの自動操作
// ---------------------------------------------------------------------------

// 「解像度を選択してください」ダイアログを閉じてゲーム本体を開始させる。
// ラジオの選択状態はth06.envに永続化されるが、どの環境でも同じ結果になるよう
// 明示的に「ウィンドウ 640x480」+VSyncありを選び直してから起動する。
bool DismissStartupDialog(unsigned int timeoutMs) {
    DWORD pid = GetCurrentProcessId();
    HWND dlg = nullptr;
    DWORD deadline = GetTickCount() + timeoutMs;
    while (GetTickCount() < deadline) {
        HWND found = dxlib::FindStartupDialog(pid);
        if (found) {
            dlg = found;
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
    LogStep(2, "メニューカーソル位置=%u。'Replay'(index=%u)までDownを送ります", idx,
        kMenuIndexReplay);
    for (int i = 0; i < kMenuNavMaxPresses && idx != kMenuIndexReplay; i++) {
        PressVKey(VK_DOWN);
        time_scale::MenuSleep(250);
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
    if (!DismissStartupDialog(/*timeoutMs=*/60000)) {
        Log("ERROR: 起動ダイアログを閉じられませんでした。中断します");
        return 1;
    }

    if (!WaitForStableWindow(GetCurrentProcessId(), /*stableMs=*/800,
                             /*timeoutMs=*/60000, WindowFilter::kDxlib)) {
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
    time_scale::MenuSleep(2000);

    LogStep(1, "Enter (デモ再生を抜けてメインメニューを表示)");
    PressVKey(VK_RETURN);
    time_scale::MenuSleep(frame_sync::Active() ? 1200 : 500);

    if (!NavigateToReplay()) {
        Log("ERROR: メインメニューで 'Replay' を選択できませんでした。中断します");
        return 1;
    }

    LogStep(3, "Enter ('Replay' を確定、リプレイ一覧へ)");
    PressVKey(VK_RETURN);
    time_scale::MenuSleep(2000);

    LogStep(4, "Enter (1番目のリプレイファイルを選択)");
    PressVKey(VK_RETURN);
    time_scale::MenuSleep(1000);

    LogStep(5, "Enter (リプレイ再生開始)");
    PressVKey(VK_RETURN);
    time_scale::MenuSleep(700);

    frame_sync::SetUnthrottled(true);
    LogSequenceComplete("th06c");
    return 0;
}

}  // namespace

BOOL APIENTRY DllMain(HMODULE hModule, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hModule);
        LogInit(hModule, "th06c_autoplay.log");
        InitRuntimeConfig();
        Log("=== th06c_replay_autoplay DllMain: DLL_PROCESS_ATTACH ===");

        const bool fs = InstallFrameSyncD3D11(64);
        // 入力・時刻・音声のGetProcAddress横取り(autoplay/dxlib_common.h)。
        dxlib::InstallHooks(dxlib::Options{});
        if (!fs) {
            // 倍速録画(Issue #288): QPC偽装とWASAPIのレート偽装・同期マーカーの準備。
            // FPS_LIMIT_TARGET_HZ未設定(等倍)ならレートは変えない。
            InstallSpeedHackHook();
            InstallWasapiHook();
        }

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
