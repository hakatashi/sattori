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
//   FRAME_SYNC_PIPE                 フレーム同期キャプチャFIFOのWindowsパス。空なら無効(実時間録画)
//   FRAME_SYNC_STOP                 フレーム同期停止トリガーファイルのWindowsパス。空なら無効
//   FRAME_SYNC_AUDIO                仮想音声出力先(44100Hz s16le 2ch RAW PCM)のWindowsパス。空なら無効
//   FRAME_SYNC_STEP_DIV             仮想時計1フレームあたりの進み幅の分母(既定はタイトル別: 32/64/1024)
//   FRAME_SYNC_SKIP_PRESENT         "0"以外なら上限解除中の本来のPresentをスキップする(既定false)
//   FRAME_SYNC_PIPELINE             "0"なら1フレームパイプライン読み出しを無効にする(既定true)
//   FRAME_SYNC_THROTTLE_WHILE_THREADS "0"以外なら短期スレッド生存中に60Hz実時間上限へ戻す(既定false)
//   FRAME_SYNC_THREAD_MAX_MS        短期スレッド追跡の上限実時間(ms、既定10000)
//   FRAME_SYNC_AUDIO_REFILL_WAIT_MS DSoundバッファ補充待ち上限実時間(ms、既定500)
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
    char frameSyncPipe[260] = {};      // 空 = 無効(実時間録画)
    char frameSyncStop[260] = {};
    char frameSyncAudio[260] = {};
    int frameSyncStepDiv = 0;          // 0 = タイトル既定値を使う
    bool frameSyncSkipPresent = false;
    bool frameSyncPipeline = true;
    bool frameSyncThrottleWhileThreads = false;
    unsigned long frameSyncThreadMaxMs = 10000;
    unsigned long frameSyncAudioRefillWaitMs = 500;

    // FPS_LIMIT_TARGET_HZ。未設定なら defaultHz。
    double TargetHzOr(double defaultHz) const {
        return fpsLimitTargetHz > 0.0 ? fpsLimitTargetHz : defaultHz;
    }
    bool FrameSyncEnabled() const { return frameSyncPipe[0] != '\0'; }
    int FrameSyncStepDivOr(int defaultDiv) const {
        return frameSyncStepDiv > 0 ? frameSyncStepDiv : (defaultDiv > 0 ? defaultDiv : 1);
    }
};

// getenv 相当の関数(name -> 値 or nullptr)から読む。テストから呼べるように分けてある。
template <typename GetEnv>
RuntimeConfig ParseRuntimeConfig(GetEnv getEnv) {
    RuntimeConfig c;
    auto copyPath = [&](const char* key, char* dst, size_t dstSize) {
        if (const char* v = getEnv(key)) {
            // lstrcpynA(MAX_PATH)と同じく、収まらない分は切り捨てる
            strncpy(dst, v, dstSize - 1);
            dst[dstSize - 1] = '\0';
        }
    };
    if (const char* v = getEnv("FPS_LIMIT_TARGET_HZ")) {
        double hz = atof(v);
        if (hz > 0.0) c.fpsLimitTargetHz = hz;
    }
    if (const char* v = getEnv("SPEED_HACK_MULTIPLIER")) {
        double m = atof(v);
        if (m > 0.0) c.speedHackMultiplier = m;
    }
    copyPath("SYNC_MARKER_TRIGGER", c.syncMarkerTrigger, sizeof(c.syncMarkerTrigger));
    if (const char* v = getEnv("D3D11_DECODE_BC7")) c.d3d11DecodeBc7 = v[0] == '1';
    if (const char* v = getEnv("D3DX_AREA_FILTER")) c.d3dxAreaFilterDisabled = strcmp(v, "0") == 0;
    if (const char* v = getEnv("MENU_WAIT_EXTRA_SCALE")) {
        double s = atof(v);
        if (s > 0.0) c.menuWaitExtraScale = s;
    }
    copyPath("FRAME_SYNC_PIPE", c.frameSyncPipe, sizeof(c.frameSyncPipe));
    copyPath("FRAME_SYNC_STOP", c.frameSyncStop, sizeof(c.frameSyncStop));
    copyPath("FRAME_SYNC_AUDIO", c.frameSyncAudio, sizeof(c.frameSyncAudio));
    if (const char* v = getEnv("FRAME_SYNC_STEP_DIV")) {
        int d = atoi(v);
        if (d > 0) c.frameSyncStepDiv = d;
    }
    if (const char* v = getEnv("FRAME_SYNC_SKIP_PRESENT")) c.frameSyncSkipPresent = atoi(v) != 0;
    if (const char* v = getEnv("FRAME_SYNC_PIPELINE")) c.frameSyncPipeline = atoi(v) != 0;
    if (const char* v = getEnv("FRAME_SYNC_THROTTLE_WHILE_THREADS")) {
        c.frameSyncThrottleWhileThreads = atoi(v) != 0;
    }
    if (const char* v = getEnv("FRAME_SYNC_THREAD_MAX_MS")) {
        int ms = atoi(v);
        if (ms >= 0) c.frameSyncThreadMaxMs = (unsigned long)ms;
    }
    if (const char* v = getEnv("FRAME_SYNC_AUDIO_REFILL_WAIT_MS")) {
        int ms = atoi(v);
        if (ms >= 0) c.frameSyncAudioRefillWaitMs = (unsigned long)ms;
    }
    return c;
}

// プロセスの環境変数から読んだ値。最初の呼び出しで読む(DllMainの最初期に InitRuntimeConfig() を呼ぶこと)。
const RuntimeConfig& Config();

// 環境変数を読み、読んだ値をMODログへ出す。LogInit() の直後に呼ぶ。
void InitRuntimeConfig();

}  // namespace autoplay
