// 倍速録画の音質劣化(reports/85 §11)切り分け用のDirectSound単体プローブ(フェーズ86)。
//
// ゲーム本体を起動せずに「DirectSoundのセカンダリバッファ再生周波数をN倍に
// スケールしたとき、Wineの内部で実際に何Hzのストリームとしてミックス・出力されるか」
// を測るための最小構成のWin32アプリ。
//
//   - WASAPI(IMMDeviceEnumerator/IAudioClient)のGetMixFormatを直接問い合わせて
//     「Wineがオーディオデバイスに対して採用するミックスフォーマット」を表示する。
//     dsound(dlls/dsound/primary.c DSOUND_WaveFormat)はこの値をそのまま
//     device->pwfx として使い、mixer.c の freqAdjustDen(リサンプル先レート)になる。
//   - 44100Hz基準の対数スイープ(20Hz〜20kHz)をセカンダリバッファに書き込み、
//     SetFrequencyでレートをスケールして再生する。録音側のスペクトルを見れば
//     どこでロールオフしているかが分かる。
//
// 使い方:
//   wine dsprobe.exe --freq 88200 --secs 30 [--coop priority|normal|writeprimary]
//                    [--primary 88200] [--silent]
#define INITGUID
#define COBJMACROS
#include <windows.h>
#include <dsound.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

static const double kBaseRate = 44100.0;

static void PrintMixFormat(void) {
    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    IMMDeviceEnumerator* devenum = NULL;
    hr = CoCreateInstance(CLSID_MMDeviceEnumerator, NULL, CLSCTX_INPROC_SERVER,
                          IID_IMMDeviceEnumerator, (void**)&devenum);
    if (FAILED(hr)) { printf("[mixfmt] CoCreateInstance failed 0x%08lX\n", (unsigned long)hr); return; }
    IMMDevice* dev = NULL;
    hr = devenum->GetDefaultAudioEndpoint(eRender, eConsole, &dev);
    if (FAILED(hr)) { printf("[mixfmt] GetDefaultAudioEndpoint failed 0x%08lX\n", (unsigned long)hr); return; }
    IAudioClient* client = NULL;
    hr = dev->Activate(IID_IAudioClient, CLSCTX_INPROC_SERVER, NULL, (void**)&client);
    if (FAILED(hr)) { printf("[mixfmt] Activate failed 0x%08lX\n", (unsigned long)hr); return; }
    WAVEFORMATEX* mix = NULL;
    hr = client->GetMixFormat(&mix);
    if (FAILED(hr)) { printf("[mixfmt] GetMixFormat failed 0x%08lX\n", (unsigned long)hr); return; }
    printf("[mixfmt] tag=%u ch=%u rate=%lu bits=%u  <<<< WASAPI mix format\n",
           mix->wFormatTag, mix->nChannels, mix->nSamplesPerSec, mix->wBitsPerSample);

    // dsoundが forcewave=TRUE(WRITEPRIMARY)のときに通す経路と同じ問い合わせ。
    WAVEFORMATEXTENSIBLE want = {};
    want.Format = *mix;
    want.Format.nSamplesPerSec = 88200;
    want.Format.nAvgBytesPerSec = want.Format.nSamplesPerSec * want.Format.nBlockAlign;
    if (mix->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
        want = *(WAVEFORMATEXTENSIBLE*)mix;
        want.Format.nSamplesPerSec = 88200;
        want.Format.nAvgBytesPerSec = want.Format.nSamplesPerSec * want.Format.nBlockAlign;
    }
    WAVEFORMATEX* closest = NULL;
    hr = client->IsFormatSupported(AUDCLNT_SHAREMODE_SHARED, &want.Format, &closest);
    printf("[mixfmt] IsFormatSupported(shared, 88200Hz) hr=0x%08lX closest_rate=%lu\n",
           (unsigned long)hr, closest ? closest->nSamplesPerSec : 0UL);
    fflush(stdout);
}

int main(int argc, char** argv) {
    double freq = 88200.0;
    int secs = 30;
    DWORD coop = DSSCL_PRIORITY;
    DWORD primaryRate = 0;
    int silent = 0;

    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--freq") && i + 1 < argc) freq = atof(argv[++i]);
        else if (!strcmp(argv[i], "--secs") && i + 1 < argc) secs = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--primary") && i + 1 < argc) primaryRate = (DWORD)atoi(argv[++i]);
        else if (!strcmp(argv[i], "--silent")) silent = 1;
        else if (!strcmp(argv[i], "--coop") && i + 1 < argc) {
            const char* v = argv[++i];
            if (!strcmp(v, "normal")) coop = DSSCL_NORMAL;
            else if (!strcmp(v, "priority")) coop = DSSCL_PRIORITY;
            else if (!strcmp(v, "exclusive")) coop = DSSCL_EXCLUSIVE;
            else if (!strcmp(v, "writeprimary")) coop = DSSCL_WRITEPRIMARY;
        }
    }

    PrintMixFormat();

    LPDIRECTSOUND8 ds = NULL;
    HRESULT hr = DirectSoundCreate8(NULL, &ds, NULL);
    if (FAILED(hr)) { printf("[ds] DirectSoundCreate8 failed 0x%08lX\n", (unsigned long)hr); return 1; }
    hr = ds->SetCooperativeLevel(GetDesktopWindow(), coop);
    printf("[ds] SetCooperativeLevel(level=%lu) hr=0x%08lX\n", coop, (unsigned long)hr);

    if (primaryRate) {
        DSBUFFERDESC pd = {};
        pd.dwSize = sizeof(pd);
        pd.dwFlags = DSBCAPS_PRIMARYBUFFER;
        LPDIRECTSOUNDBUFFER pb = NULL;
        hr = ds->CreateSoundBuffer(&pd, &pb, NULL);
        printf("[ds] CreateSoundBuffer(primary) hr=0x%08lX\n", (unsigned long)hr);
        if (SUCCEEDED(hr)) {
            WAVEFORMATEX cur = {};
            DWORD written = 0;
            pb->GetFormat(&cur, sizeof(cur), &written);
            printf("[ds] primary current: ch=%u rate=%lu bits=%u\n", cur.nChannels,
                   cur.nSamplesPerSec, cur.wBitsPerSample);
            WAVEFORMATEX nf = cur;
            nf.nSamplesPerSec = primaryRate;
            nf.nBlockAlign = nf.nChannels * nf.wBitsPerSample / 8;
            nf.nAvgBytesPerSec = nf.nSamplesPerSec * nf.nBlockAlign;
            hr = pb->SetFormat(&nf);
            printf("[ds] primary SetFormat(%lu) hr=0x%08lX\n", primaryRate, (unsigned long)hr);
            WAVEFORMATEX after = {};
            pb->GetFormat(&after, sizeof(after), &written);
            printf("[ds] primary after: rate=%lu\n", after.nSamplesPerSec);
        }
    }

    // 44100Hz基準・16bitステレオの対数スイープ(20Hz→20kHz)を10秒分作る。
    const int sweepSecs = 10;
    const int nSamples = (int)(kBaseRate * sweepSecs);
    WAVEFORMATEX wfx = {};
    wfx.wFormatTag = WAVE_FORMAT_PCM;
    wfx.nChannels = 2;
    wfx.nSamplesPerSec = (DWORD)kBaseRate;
    wfx.wBitsPerSample = 16;
    wfx.nBlockAlign = wfx.nChannels * wfx.wBitsPerSample / 8;
    wfx.nAvgBytesPerSec = wfx.nSamplesPerSec * wfx.nBlockAlign;

    DSBUFFERDESC bd = {};
    bd.dwSize = sizeof(bd);
    bd.dwFlags = DSBCAPS_CTRLFREQUENCY | DSBCAPS_GETCURRENTPOSITION2 | DSBCAPS_GLOBALFOCUS;
    bd.dwBufferBytes = nSamples * wfx.nBlockAlign;
    bd.lpwfxFormat = &wfx;
    LPDIRECTSOUNDBUFFER buf = NULL;
    hr = ds->CreateSoundBuffer(&bd, &buf, NULL);
    if (FAILED(hr)) { printf("[ds] CreateSoundBuffer(secondary) failed 0x%08lX\n", (unsigned long)hr); return 1; }

    void* p1 = NULL; DWORD b1 = 0; void* p2 = NULL; DWORD b2 = 0;
    hr = buf->Lock(0, bd.dwBufferBytes, &p1, &b1, &p2, &b2, 0);
    if (FAILED(hr)) { printf("[ds] Lock failed 0x%08lX\n", (unsigned long)hr); return 1; }
    short* s = (short*)p1;
    const double f0 = 20.0, f1 = 20000.0;
    const double T = (double)sweepSecs;
    const double K = T * f0 / log(f1 / f0);
    const double L = log(f1 / f0) / T;
    for (int i = 0; i < nSamples; i++) {
        double t = i / kBaseRate;
        double phase = 2.0 * 3.14159265358979323846 * K * (exp(t * L) - 1.0);
        short v = silent ? 0 : (short)(sin(phase) * 12000.0);
        s[2 * i] = v;
        s[2 * i + 1] = v;
    }
    buf->Unlock(p1, b1, p2, b2);

    DWORD curFreq = 0;
    buf->GetFrequency(&curFreq);
    hr = buf->SetFrequency((DWORD)freq);
    DWORD newFreq = 0;
    buf->GetFrequency(&newFreq);
    printf("[ds] secondary freq %lu -> SetFrequency(%lu) hr=0x%08lX -> get=%lu\n",
           curFreq, (DWORD)freq, (unsigned long)hr, newFreq);
    fflush(stdout);

    buf->Play(0, 0, DSBPLAY_LOOPING);
    printf("[ds] playing for %d sec...\n", secs);
    fflush(stdout);
    Sleep(secs * 1000);
    buf->Stop();
    printf("[ds] done\n");
    return 0;
}
