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

#include <string.h>

#include "autoplay/title_main.h"
#include "core/code_patch.h"
#include "core/log.h"
#include "core/runtime_config.h"
#include "present/capture/d3d9_readback.h"
#include "present/limiter.h"
#include "texture/d3dx_filter.h"

using namespace autoplay;

namespace {

const MenuStep kMenu[] = {
    {.key = Key::kDown, .repeat = 2, .waitMs = 250, .label = "Down x2 (select 'Replay' on main menu)"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (confirm 'Replay', enter replay list)"},
    {.key = Key::kRight, .waitMs = 500, .label = "Right (switch to user replay tab)"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (select 1st user replay file)"},
    {.key = Key::kReturn, .waitMs = 700, .label = "Enter (confirm playback, start replay)"},
};

// 倍速録画時の画面上fps表示の補正。VsyncPatch(vpatch_th12.dll)が表示用のfps値を自前の
// 実時間タイマーで書き込むため、倍速では「120fps」と表示される(th12のvpatchは`CalcFPS`
// を読まず、QPC/timeGetTime/GetTickCountを偽装しても変わらないことを実機で確認した)。
// 表示関数(RVA 0x1cc9e)が`[eax+0x34]`のfloatを読む命令の直後に係数(60/FPS_LIMIT_TARGET_HZ)
// を掛けるコードを差し込む。命令列が想定と違うexeでは何もしない(表示が実測値のままになる
// だけで実害はない)。
void InstallFpsDisplayScalePatch(double targetHz) {
    static const ULONG_PTR kRva = 0x1cc9e;
    static const BYTE kExpected[10] = {0xd9, 0x40, 0x34, 0x56, 0x8b, 0x35, 0xb8, 0x43, 0x4b, 0x00};
    if (!code_patch::Matches(kRva, kExpected, sizeof(kExpected))) {
        Log("InstallFpsDisplayScalePatch: unexpected bytes at RVA 0x%lx, skipped", (unsigned long)kRva);
        return;
    }
    BYTE* site = code_patch::At(kRva);
    BYTE* cave = code_patch::AllocCave(64);
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
    code_patch::EmitJmp(p, site + 10);                      // jmp site+10

    code_patch::RedirectTo(site, 10, cave);                 // site: jmp cave; nop x5
    Log("InstallFpsDisplayScalePatch: OK (factor=%.4f)", factor);
}

const TitleSpec kSpec = {
    .name = "th12",
    .titleWaitMs = 6000,
    .titleWaitMsFrameSync = 8000,
    .menu = kMenu,
    // D3DXLoadSurfaceFromMemoryの縮小フィルタ補完(文字のジャギー対策、touhou-recorder
    // reports/101・102)。既定で有効(D3DX_AREA_FILTER=0で無効)。
    .textFilter = InstallD3DXFilterHook,
    .installFrameSync = InstallFrameSyncD3D9,
    .frameSyncStepDiv = 1024,
    // 倍速録画(reports/89)ではPresentの上限をFPS_LIMIT_TARGET_HZ(60×倍率)に合わせる
    // (touhou-recorderでは低速録画検証のフェーズ58・62から同じ構成)。**等倍では入れない**:
    // このタイトルはVsyncPatchが60fpsへのフレーム制御を担っており、present/limiterは
    // FPS_LIMIT_TARGET_HZ未設定でも60fpsで間引くため、二重の制御でゲーム進行が約3%遅れた
    // (MOD統合テストで被弾タイミングが127秒時点で4.1秒遅延、Issue #288)。
    .installLimiter = InstallFpsLimiterHook,
    .limiterOnlyWhenScaled = true,
    // 倍速(FPS_LIMIT_TARGET_HZ が 60 以外)のときだけ fps 表示を補正する。
    .realtimeExtra = [] {
        const double targetHz = Config().fpsLimitTargetHz;
        if (targetHz > 0.0 && targetHz != 60.0) InstallFpsDisplayScalePatch(targetHz);
    },
    // リプレイずれ判定用のスコア等サンプリング(Issue #103)。RVAはthprac
    // (thprac_th12.cppの`THAdvOptWnd`内、プラクティスモードパラメータ書き込み
    // コード)から収集した絶対VA(0x4b0c44=score)を、image base(0x400000)を
    // 引いたRVA(0xb0c44)を基点としたオフセットに整理したもの。score(内部値)は
    // 画面表示値の1/10(th07/th08/th10/th11/th20と同じ×10系列)。th10・th11と
    // 同じくポインタ間接参照は不要(固定RVAに直接値が置かれる)。フル尺録画
    // (通常・Extraステージ両方)で記録スコアとの完全一致を実機確認済み
    // (touhou-recorder reports/62)。
    .scoreMonitor = {
        .baseRva = 0xb0c44,
        .scoreOffset = 0x00,
        .scoreWidth = 4,
        .stageOffset = 0x6c,
        .stageWidth = 4,
        .livesOffset = 0x54,
        .livesWidth = 4,
        .grazeOffset = 0x98,
        .grazeWidth = 4,
    },
};

}  // namespace

DEFINE_TITLE(kSpec)
