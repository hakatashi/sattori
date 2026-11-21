#pragma once
#include <stdlib.h>
#include <string.h>

// MODが読む環境変数(ワーカーの recording/config.py の GameConfig.build_env() などが渡す)。
//
// **環境変数はここでだけ読む。** プロセスの起動時(DllMain)に1回だけ読み、以後は Config() の
// 値を使う。かつては同じ変数を12か所で getenv していた(Issue #393)。
//
//   FPS_LIMIT_TARGET_HZ    録画速度の目標fps(60×倍率)。未設定・0以下なら等倍(0として持つ)
//   SPEED_HACK_MULTIPLIER  QPC偽装の倍率(clock/speed_hack)。未設定・0以下なら1.0
//                          ワーカーが FPS_LIMIT_TARGET_HZ から導出して渡す(出所は1つ)
//   SYNC_MARKER_TRIGGER    同期マーカーのトリガーファイル(Windows形式のパス)。空なら無効
//   D3D11_DECODE_BC7       "1"ならBC7テクスチャを展開する(texture/d3d11_bc7、th06ncのCPU描画)
//   D3DX_AREA_FILTER       "0"なら文字の縮小フィルタ補完を無効にする(texture/d3dx_filter)
//   MENU_WAIT_EXTRA_SCALE  手動の検証専用。メニュー待ち(core/time_scale.h)にさらに掛ける倍率
//                          (fpsが極端に落ちる環境での動作確認用。ワーカーは渡さない)。既定1.0
//
// かつての TH06NC_TIME_SCALE(th06ncのメニュー待ちの倍率)は、本番では FPS_LIMIT_TARGET_HZ から
// 導ける値(低速録画の 60/FPS_LIMIT_TARGET_HZ)だったので、出所を FPS_LIMIT_TARGET_HZ の1つにした
// (Issue #393)。手動の検証で使っていた用途は MENU_WAIT_EXTRA_SCALE が引き継ぐ。
//
// ホストの g++ でテストできるよう、Win32 に依存する部分(Config() の実体)は .cpp に置く。

namespace autoplay {

struct RuntimeConfig {
    double fpsLimitTargetHz = 0.0;     // 0 = 未設定(等倍)
    double speedHackMultiplier = 1.0;  // 1.0 = 未設定
    char syncMarkerTrigger[260] = {};  // 空 = 無効(MAX_PATH)
    bool d3d11DecodeBc7 = false;
    bool d3dxAreaFilterDisabled = false;
    double menuWaitExtraScale = 1.0;   // 1.0 = 未設定

    // FPS_LIMIT_TARGET_HZ。未設定なら defaultHz。
    double TargetHzOr(double defaultHz) const {
        return fpsLimitTargetHz > 0.0 ? fpsLimitTargetHz : defaultHz;
    }
};

// getenv 相当の関数(name -> 値 or nullptr)から読む。テストから呼べるように分けてある。
template <typename GetEnv>
RuntimeConfig ParseRuntimeConfig(GetEnv getEnv) {
    RuntimeConfig c;
    if (const char* v = getEnv("FPS_LIMIT_TARGET_HZ")) {
        double hz = atof(v);
        if (hz > 0.0) c.fpsLimitTargetHz = hz;
    }
    if (const char* v = getEnv("SPEED_HACK_MULTIPLIER")) {
        double m = atof(v);
        if (m > 0.0) c.speedHackMultiplier = m;
    }
    if (const char* v = getEnv("SYNC_MARKER_TRIGGER")) {
        // lstrcpynA(MAX_PATH)と同じく、収まらない分は切り捨てる
        strncpy(c.syncMarkerTrigger, v, sizeof(c.syncMarkerTrigger) - 1);
        c.syncMarkerTrigger[sizeof(c.syncMarkerTrigger) - 1] = '\0';
    }
    if (const char* v = getEnv("D3D11_DECODE_BC7")) c.d3d11DecodeBc7 = v[0] == '1';
    if (const char* v = getEnv("D3DX_AREA_FILTER")) c.d3dxAreaFilterDisabled = strcmp(v, "0") == 0;
    if (const char* v = getEnv("MENU_WAIT_EXTRA_SCALE")) {
        double s = atof(v);
        if (s > 0.0) c.menuWaitExtraScale = s;
    }
    return c;
}

// プロセスの環境変数から読んだ値。最初の呼び出しで読む(DllMainの最初期に InitRuntimeConfig() を呼ぶこと)。
const RuntimeConfig& Config();

// 環境変数を読み、読んだ値をMODログへ出す。LogInit() の直後に呼ぶ。
void InitRuntimeConfig();

}  // namespace autoplay
