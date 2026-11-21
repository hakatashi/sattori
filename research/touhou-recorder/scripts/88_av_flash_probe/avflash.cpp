// フェーズ88: A/V同期の「正解」を作る合成プローブ(Wine上で動かす)。
//
// 320x240のポップアップウィンドウ(画面左上)を黒で描き、一定間隔で
//   DirectSoundのクリック用バッファをPlay → 直後にウィンドウを白で塗る(200ms後に黒へ戻す)
// を繰り返す。音と光が同時に発生するので、録画パイプラインと同じffmpegコマンドで
// 録った結果の「光った時刻 − クリックの時刻」がそのままA/V同期の誤差になる。
//
// さらに mods/common/dsound_hook.cpp と同じ同期マーカー(環境変数SYNC_MARKER_TRIGGERの
// ファイルが置かれたら、同じ系列・振幅・長さのノイズを同じデバイスから鳴らしてPlay直前の
// 壁時計時刻をログに出す)を実装し、recorder/sync_marker.py の補正をゲーム抜きで検証する。
//
// Usage: avflash.exe --freq 44100 --log Z:\tmp\avflash.log --start 7 --count 8 --interval 1.5
// ビルド: scripts/88_av_flash_probe/build_mingw.sh
#include <windows.h>
#include <mmsystem.h>
#include <dsound.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static FILE* g_log = nullptr;
static double EpochNow() {
    FILETIME ft;
    GetSystemTimePreciseAsFileTime(&ft);
    ULONGLONG t = ((ULONGLONG)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
    return (double)(t - 116444736000000000ULL) / 1e7;
}
static void Log(const char* fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vfprintf(g_log, fmt, ap);
    va_end(ap);
    fputc('\n', g_log);
    fflush(g_log);
}

// Wineはウィンドウへの GDI 描画をいったんウィンドウサーフェスに溜め、メッセージ処理の
// タイミングでXへ反映する。描画直後にメッセージを汲んで即座に画面へ出させる。
static void Pump() {
    MSG msg;
    while (PeekMessage(&msg, NULL, 0, 0, PM_REMOVE)) DispatchMessage(&msg);
}

static void Paint(HWND hwnd, HDC dc, const RECT* rc, HBRUSH br) {
    FillRect(dc, rc, br);
    GdiFlush();
    RedrawWindow(hwnd, NULL, NULL, RDW_UPDATENOW);
    Pump();
}

static LPDIRECTSOUNDBUFFER MakeBuffer(LPDIRECTSOUND8 ds, DWORD rate, DWORD frames) {
    WAVEFORMATEX wf = {};
    wf.wFormatTag = WAVE_FORMAT_PCM; wf.nChannels = 1; wf.nSamplesPerSec = rate;
    wf.wBitsPerSample = 16; wf.nBlockAlign = 2; wf.nAvgBytesPerSec = rate * 2;
    DSBUFFERDESC bd = {};
    bd.dwSize = sizeof(bd);
    bd.dwFlags = DSBCAPS_GLOBALFOCUS | DSBCAPS_GETCURRENTPOSITION2;
    bd.dwBufferBytes = frames * 2;
    bd.lpwfxFormat = &wf;
    LPDIRECTSOUNDBUFFER buf = NULL;
    if (FAILED(ds->CreateSoundBuffer(&bd, &buf, NULL))) return NULL;
    return buf;
}

int main(int argc, char** argv) {
    DWORD freq = 44100;
    const char* logPath = "avflash.log";
    double startSec = 7.0, interval = 1.5;
    int count = 8;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--freq") && i + 1 < argc) freq = (DWORD)atoi(argv[++i]);
        else if (!strcmp(argv[i], "--log") && i + 1 < argc) logPath = argv[++i];
        else if (!strcmp(argv[i], "--start") && i + 1 < argc) startSec = atof(argv[++i]);
        else if (!strcmp(argv[i], "--count") && i + 1 < argc) count = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--interval") && i + 1 < argc) interval = atof(argv[++i]);
    }
    g_log = fopen(logPath, "w");
    if (!g_log) return 1;

    HWND hwnd = CreateWindowExA(WS_EX_TOPMOST, "STATIC", "avflash", WS_POPUP | WS_VISIBLE,
                                0, 0, 320, 240, NULL, NULL, NULL, NULL);
    HDC dc = GetDC(hwnd);
    RECT rc = {0, 0, 320, 240};
    HBRUSH black = (HBRUSH)GetStockObject(BLACK_BRUSH), white = (HBRUSH)GetStockObject(WHITE_BRUSH);
    Paint(hwnd, dc, &rc, black);

    LPDIRECTSOUND8 ds = NULL;
    if (FAILED(DirectSoundCreate8(NULL, &ds, NULL))) { Log("DirectSoundCreate8 failed"); return 1; }
    ds->SetCooperativeLevel(hwnd, DSSCL_PRIORITY);

    // クリック: 等倍換算で10ms(freq/100サンプル)の矩形。
    DWORD clickFrames = freq / 2;
    LPDIRECTSOUNDBUFFER click = MakeBuffer(ds, freq, clickFrames);
    void *p1, *p2; DWORD n1, n2;
    click->Lock(0, clickFrames * 2, &p1, &n1, &p2, &n2, 0);
    memset(p1, 0, n1);
    for (DWORD j = 0; j < freq / 100; j++) ((short*)p1)[j] = 20000;
    click->Unlock(p1, n1, p2, n2);

    // 同期マーカー(dsound_hook.cpp と同一の系列・振幅・長さ)。
    const DWORD kSamples = 131072;
    const short kAmp = 256;
    const DWORD kSeed = 0x2545F491u;
    LPDIRECTSOUNDBUFFER marker = MakeBuffer(ds, freq, kSamples);
    marker->Lock(0, kSamples * 2, &p1, &n1, &p2, &n2, 0);
    DWORD x = kSeed;
    for (DWORD i = 0; i < n1 / 2; i++) {
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        ((short*)p1)[i] = (x & 1) ? kAmp : (short)-kAmp;
    }
    marker->Unlock(p1, n1, p2, n2);

    const char* trig = getenv("SYNC_MARKER_TRIGGER");
    double t0 = EpochNow();
    bool markerDone = false;
    int done = 0;
    MSG msg;
    while (done < count) {
        while (PeekMessage(&msg, NULL, 0, 0, PM_REMOVE)) DispatchMessage(&msg);
        double now = EpochNow();
        if (!markerDone && trig && GetFileAttributesA(trig) != INVALID_FILE_ATTRIBUTES) {
            double te = EpochNow();
            HRESULT hr = marker->Play(0, 0, 0);
            Log("SYNC_MARKER played epoch=%.6f play_call_sec=%.6f rate=%lu samples=%lu amp=%d seed=0x%08lX hr=0x%08lX",
                te, EpochNow() - te, freq, kSamples, (int)kAmp, kSeed, (unsigned long)hr);
            markerDone = true;
        }
        if (now >= t0 + startSec + done * interval) {
            click->SetCurrentPosition(0);
            double tp = EpochNow();
            click->Play(0, 0, 0);
            Paint(hwnd, dc, &rc, white);
            Log("FLASH %d epoch=%.6f painted_after=%.6f", done, tp, EpochNow() - tp);
            for (int k = 0; k < 40; k++) { Sleep(5); Pump(); }
            Paint(hwnd, dc, &rc, black);
            done++;
        }
        Sleep(1);
    }
    Sleep(1500);
    Log("DONE");
    return 0;
}
