// フェーズ88: 「鳴り続けるゲーム」を模したDirectSoundクリック源。
//
// scripts/87_dsound_latency_probe/dslatency.cpp は「録音開始→プローブ起動→Play」の順で測っていたが、
// 実際の録画パイプライン(recorder/pipeline.py)は「ゲーム起動(音声ストリーム接続済み・再生中)→
// ffmpeg(音声)起動」の順である。本プローブは44100Hz基準で1秒に1回クリックが鳴るバッファを
// DSBPLAY_LOOPINGで鳴らし続け、Play直前の壁時計時刻(UNIX epoch秒)を出力する。
// クリック m 回目(m=0,1,2,...)の理論上の発音時刻は PLAY_EPOCH + m * CLICK_INTERVAL。
//
// --freq で SetFrequency(倍速録画の dsound_hook と同じ操作)、--secs で鳴らし続ける秒数を指定。
// ビルド: scripts/88_dsound_loop_probe/build_mingw.sh
#include <windows.h>
#include <mmsystem.h>
#include <dsound.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static double EpochNow() {
    FILETIME ft;
    GetSystemTimePreciseAsFileTime(&ft);
    ULONGLONG t = ((ULONGLONG)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
    return (double)(t - 116444736000000000ULL) / 1e7;
}

int main(int argc, char** argv) {
    DWORD freq = 44100;
    int secs = 30;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--freq") && i + 1 < argc) freq = (DWORD)atoi(argv[++i]);
        else if (!strcmp(argv[i], "--secs") && i + 1 < argc) secs = atoi(argv[++i]);
    }
    const DWORD baseRate = 44100;
    HWND hwnd = CreateWindowA("STATIC", "dsloop", WS_OVERLAPPEDWINDOW, 0, 0, 100, 100, NULL, NULL, NULL, NULL);
    LPDIRECTSOUND8 ds = NULL;
    if (FAILED(DirectSoundCreate8(NULL, &ds, NULL))) { printf("DirectSoundCreate8 failed\n"); return 1; }
    ds->SetCooperativeLevel(hwnd, DSSCL_PRIORITY);

    WAVEFORMATEX wf = {};
    wf.wFormatTag = WAVE_FORMAT_PCM; wf.nChannels = 1; wf.nSamplesPerSec = baseRate;
    wf.wBitsPerSample = 16; wf.nBlockAlign = 2; wf.nAvgBytesPerSec = baseRate * 2;
    DSBUFFERDESC bd = {};
    bd.dwSize = sizeof(bd);
    bd.dwFlags = DSBCAPS_CTRLFREQUENCY | DSBCAPS_GLOBALFOCUS | DSBCAPS_GETCURRENTPOSITION2;
    bd.dwBufferBytes = baseRate * 2;  // 1秒(基準レート)
    bd.lpwfxFormat = &wf;
    LPDIRECTSOUNDBUFFER buf = NULL;
    if (FAILED(ds->CreateSoundBuffer(&bd, &buf, NULL))) { printf("CreateSoundBuffer failed\n"); return 1; }
    void *p1, *p2; DWORD n1, n2;
    buf->Lock(0, bd.dwBufferBytes, &p1, &n1, &p2, &n2, 0);
    short* s = (short*)p1;
    memset(s, 0, n1);
    for (int j = 0; j < 64; j++) s[j] = 20000;  // バッファ先頭=Play時刻にクリック
    buf->Unlock(p1, n1, p2, n2);
    buf->SetFrequency(freq);
    Sleep(1000);  // デバイスのオープン・ミキサースレッドの立ち上がりを待つ
    double t0 = EpochNow();
    buf->Play(0, 0, DSBPLAY_LOOPING);
    printf("PLAY_EPOCH %.6f FREQ %lu CLICK_INTERVAL %.6f\n", t0, freq, (double)baseRate / freq);
    fflush(stdout);
    Sleep((DWORD)secs * 1000);
    buf->Stop();
    buf->Release();
    ds->Release();
    return 0;
}
