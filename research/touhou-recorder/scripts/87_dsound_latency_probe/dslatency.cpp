// フェーズ87: Wine DirectSound の出力遅延(Play呼び出し → PulseAudioシンクに音が出るまで)を測るプローブ。
//
// 44100Hz基準で「1秒ごとにクリック」を並べたセカンダリバッファを作り、SetFrequency(--freq)で
// 再生周波数をスケールして(倍速録画のdsound_hookと同じ操作)Playする。Play直前の壁時計時刻
// (UNIX epoch秒)を標準出力へ出すので、同じシンクのmonitorを `ffmpeg -copyts -f pulse` で
// 録音しておき、録音上のクリックの絶対時刻との差から出力遅延を求める
// (scripts/87_measure_dsound_latency.py が一連の手順を自動化する)。
//
// ビルド: scripts/87_dsound_latency_probe/build_mingw.sh
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
    int clicks = 6;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--freq") && i + 1 < argc) freq = (DWORD)atoi(argv[++i]);
        else if (!strcmp(argv[i], "--clicks") && i + 1 < argc) clicks = atoi(argv[++i]);
    }
    const DWORD baseRate = 44100;
    HWND hwnd = CreateWindowA("STATIC", "dslatency", WS_OVERLAPPEDWINDOW, 0, 0, 100, 100, NULL, NULL, NULL, NULL);
    LPDIRECTSOUND8 ds = NULL;
    if (FAILED(DirectSoundCreate8(NULL, &ds, NULL))) { printf("DirectSoundCreate8 failed\n"); return 1; }
    ds->SetCooperativeLevel(hwnd, DSSCL_PRIORITY);

    WAVEFORMATEX wf = {};
    wf.wFormatTag = WAVE_FORMAT_PCM; wf.nChannels = 1; wf.nSamplesPerSec = baseRate;
    wf.wBitsPerSample = 16; wf.nBlockAlign = 2; wf.nAvgBytesPerSec = baseRate * 2;
    DWORD frames = baseRate * (clicks + 1);
    DSBUFFERDESC bd = {};
    bd.dwSize = sizeof(bd);
    bd.dwFlags = DSBCAPS_CTRLFREQUENCY | DSBCAPS_GLOBALFOCUS | DSBCAPS_GETCURRENTPOSITION2;
    bd.dwBufferBytes = frames * 2;
    bd.lpwfxFormat = &wf;
    LPDIRECTSOUNDBUFFER buf = NULL;
    if (FAILED(ds->CreateSoundBuffer(&bd, &buf, NULL))) { printf("CreateSoundBuffer failed\n"); return 1; }
    void *p1, *p2; DWORD n1, n2;
    buf->Lock(0, bd.dwBufferBytes, &p1, &n1, &p2, &n2, 0);
    short* s = (short*)p1;
    memset(s, 0, n1);
    // クリックはバッファ上の k 秒目(44100Hz基準)。SetFrequencyでN倍にすると実時間 k/N 秒目に鳴る。
    for (int k = 1; k <= clicks; k++)
        for (int j = 0; j < 64; j++) s[k * baseRate + j] = 20000;
    buf->Unlock(p1, n1, p2, n2);
    buf->SetFrequency(freq);
    Sleep(1500);  // デバイスのオープン・ミキサースレッドの立ち上がりを待つ
    double t0 = EpochNow();
    buf->Play(0, 0, 0);
    printf("PLAY_EPOCH %.6f FREQ %lu CLICK_INTERVAL %.6f\n", t0, freq, (double)baseRate / freq);
    fflush(stdout);
    Sleep((DWORD)(1000.0 * (clicks + 1) * baseRate / freq) + 1000);
    buf->Stop();
    buf->Release();
    ds->Release();
    return 0;
}
