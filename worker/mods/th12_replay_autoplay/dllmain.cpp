// th12(東方星蓮船 / Undefined Fantastic Object)の自動再生MOD。
//
// メインメニュー -> Replay -> (ユーザーリプレイタブへ切替) -> (1番目選択) -> (再生確定)
// を自動操作する。**th12は既存2タイトルのどちらとも完全一致しないハイブリッド仕様**である
// 点に注意:
//
// - 入力注入経路はth10と同じ(DirectInput GetDeviceStateが実際に56〜60Hzでポーリング
//   される。FpsMonitorログで確認、touhou-recorder reports/61)。th11用に実装した
//   Win32 GetKeyboardStateフック(PressVKey)は使えない —— 最初にこちらで実装したところ
//   ビルド・注入・「sequence complete」ログ出力までは正常に完了したが、実際には
//   メニュー操作が一切反映されず、リプレイがタイトル画面のアトラクトデモのまま進行
//   しなかった(WaitForHookActiveはGetDeviceState/GetKeyboardStateのどちらかが
//   呼ばれていれば成立してしまうため、この誤りは起動時エラーとして検出できない)。
//   PressKey(DIKスキャンコード経由)に切り替えて解消した。
// - メニュー操作シーケンス自体はth11と同じ(Down x2 -> Enter(Replay) ->
//   Right(ユーザーリプレイタブへ切替) -> Enter(1番目選択) -> Enter(再生確定))。
//   th10にある「PRESS ANY BUTTON表示をEnterで消す」ステップはth12には無い。
//
// この2点を混同して「th10だからth10のシーケンスをそのまま使う」「th11だから
// GetKeyboardStateを使う」と早合点しないこと。

#include <windows.h>
#include <stdlib.h>
#include <string.h>
#include "../common/dinput_hook.h"
#include "../common/window_wait.h"
#include "../common/menu_wait.h"
#include "../common/logging.h"
#include "../common/speed_hack_hook.h"
#include "../common/fps_limiter_hook.h"
#include "../common/dsound_hook.h"
#include "../common/fps_monitor.h"
#include "../common/score_monitor.h"

using namespace autoplay;

// DirectInput scan codes.
static const BYTE DIK_DOWN = 0xD0;
static const BYTE DIK_RIGHT = 0xCD;
static const BYTE DIK_RETURN = 0x1C;

static DWORD WINAPI AutoPlayThread(LPVOID) {
    Log("=== th12_replay_autoplay: AutoPlayThread started ===");

    DWORD pid = GetCurrentProcessId();
    HWND hwnd = WaitForStableWindow(pid, /*stableMs=*/800, /*timeoutMs=*/30000);
    if (!hwnd) {
        Log("ERROR: game window never appeared, aborting sequence");
        return 1;
    }

    if (!WaitForHookActive(/*timeoutMs=*/30000)) {
        Log("ERROR: GetDeviceState hook was never called, aborting sequence");
        return 1;
    }

    Log("Buffering 6000ms for title screen logo animation...");
    MenuSleep(6000);

    Log("Step 1: Down x2 (select 'Replay' on main menu)");
    for (int i = 0; i < 2; i++) {
        PressKey(DIK_DOWN);
        MenuSleep(250);
    }

    Log("Step 2: Enter (confirm 'Replay', enter replay list)");
    PressKey(DIK_RETURN);
    MenuSleep(700);

    Log("Step 3: Right (switch to user replay tab)");
    PressKey(DIK_RIGHT);
    MenuSleep(500);

    // th11と同じスロット命名規約: 対象リプレイをインスタンスのreplay/配下に
    // "th12_ud0000.rpy"として配置しておく必要がある(record_th12.pyのcanonical_slot)。
    Log("Step 4: Enter (select 1st user replay file)");
    PressKey(DIK_RETURN);
    MenuSleep(700);

    Log("Step 5: Enter (confirm playback, start replay)");
    PressKey(DIK_RETURN);
    MenuSleep(700);

    Log("=== th12_replay_autoplay: sequence complete ===");
    return 0;
}

// 倍速録画時の画面上fps表示の補正。VsyncPatch(vpatch_th12.dll)が表示用のfps値を自前の
// 実時間タイマーで書き込むため、倍速では「120fps」と表示される(th12のvpatchは`CalcFPS`
// を読まず、QPC/timeGetTime/GetTickCountを偽装しても変わらないことを実機で確認した)。
// 表示関数(RVA 0x1cc9e)が`[eax+0x34]`のfloatを読む命令の直後に係数(60/FPS_LIMIT_TARGET_HZ)
// を掛けるコードを差し込む。命令列が想定と違うexeでは何もしない(表示が実測値のままになる
// だけで実害はない)。
static void InstallFpsDisplayScalePatch(double targetHz) {
    static const ULONG_PTR kRva = 0x1cc9e;
    static const BYTE kExpected[10] = {0xd9, 0x40, 0x34, 0x56, 0x8b, 0x35, 0xb8, 0x43, 0x4b, 0x00};
    BYTE* site = (BYTE*)GetModuleHandle(NULL) + kRva;
    if (memcmp(site, kExpected, sizeof(kExpected)) != 0) {
        Log("InstallFpsDisplayScalePatch: unexpected bytes at RVA 0x%lx, skipped", (unsigned long)kRva);
        return;
    }
    BYTE* cave = (BYTE*)VirtualAlloc(NULL, 64, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
    if (!cave) {
        Log("InstallFpsDisplayScalePatch: VirtualAlloc failed");
        return;
    }
    float factor = (float)(60.0 / targetHz);
    BYTE* constPtr = cave + 32;
    memcpy(constPtr, &factor, sizeof(factor));
    BYTE* p = cave;
    *p++ = 0xd9; *p++ = 0x40; *p++ = 0x34;                  // fld dword [eax+0x34]
    *p++ = 0xd8; *p++ = 0x0d;                               // fmul dword [constPtr]
    DWORD addr = (DWORD)(ULONG_PTR)constPtr;
    memcpy(p, &addr, 4); p += 4;
    *p++ = 0x56;                                            // push esi
    *p++ = 0x8b; *p++ = 0x35; *p++ = 0xb8; *p++ = 0x43; *p++ = 0x4b; *p++ = 0x00; // mov esi,[0x4b43b8]
    *p++ = 0xe9;                                            // jmp site+10
    LONG rel = (LONG)((site + 10) - (p + 4));
    memcpy(p, &rel, 4);

    DWORD oldProt;
    VirtualProtect(site, 10, PAGE_EXECUTE_READWRITE, &oldProt);
    site[0] = 0xe9;
    LONG toCave = (LONG)(cave - (site + 5));
    memcpy(site + 1, &toCave, 4);
    for (int i = 5; i < 10; i++) site[i] = 0x90;
    VirtualProtect(site, 10, oldProt, &oldProt);
    FlushInstructionCache(GetCurrentProcess(), site, 10);
    Log("InstallFpsDisplayScalePatch: OK (factor=%.4f)", factor);
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinst);
        LogInit(hinst, "th12_autoplay.log");
        Log("DLL_PROCESS_ATTACH: installing IAT hook");
        InstallDinputHook();
        // 倍速録画(reports/89): SPEED_HACK_MULTIPLIER未設定(等倍)なら何もしない。
        InstallSpeedHackHook();
        // 倍速録画(reports/89)ではPresentの上限をFPS_LIMIT_TARGET_HZ(60×倍率)に合わせる
        // (touhou-recorderでは低速録画検証のフェーズ58・62から同じ構成)。**等倍では入れない**:
        // このタイトルはVsyncPatchが60fpsへのフレーム制御を担っており、fps_limiter_hookは
        // FPS_LIMIT_TARGET_HZ未設定でも60fpsで間引くため、二重の制御でゲーム進行が約3%遅れた
        // (MOD統合テストで被弾タイミングが127秒時点で4.1秒遅延、Issue #288)。
        {
            const char* hz = getenv("FPS_LIMIT_TARGET_HZ");
            double targetHz = hz ? atof(hz) : 0.0;
            if (targetHz > 0.0 && targetHz != 60.0) {
                InstallFpsLimiterHook(targetHz);
                InstallFpsDisplayScalePatch(targetHz);
            }
        }
        // BGM/SEの再生周波数をFPS_LIMIT_TARGET_HZ/60倍にスケールし(等倍なら無変更)、
        // A/V同期マーカー(reports/88)を有効にする。
        InstallDSoundHook(1.0);
        // リプレイずれ判定用のスコア等サンプリング(Issue #103)。RVAはthprac
        // (thprac_th12.cppの`THAdvOptWnd`内、プラクティスモードパラメータ書き込み
        // コード)から収集した絶対VA(0x4b0c44=score)を、image base(0x400000)を
        // 引いたRVA(0xb0c44)を基点としたオフセットに整理したもの。score(内部値)は
        // 画面表示値の1/10(th07/th08/th10/th11/th20と同じ×10系列)。th10・th11と
        // 同じくポインタ間接参照は不要(固定RVAに直接値が置かれる)。フル尺録画
        // (通常・Extraステージ両方)で記録スコアとの完全一致を実機確認済み
        // (touhou-recorder reports/62)。
        {
            ScoreMonitorConfig sm;
            sm.baseRva = 0xb0c44;
            sm.baseIsPointer = false;
            sm.scoreOffset = 0x00;
            sm.scoreWidth = 4;
            sm.stageOffset = 0x6c;
            sm.stageWidth = 4;
            sm.livesOffset = 0x54;
            sm.livesWidth = 4;
            sm.grazeOffset = 0x98;
            sm.grazeWidth = 4;
            sm.intervalMs = 1000;
            StartScoreMonitorThread(sm);
        }
        StartFpsMonitorThread();
        CreateThread(NULL, 0, AutoPlayThread, NULL, 0, NULL);
    }
    return TRUE;
}
