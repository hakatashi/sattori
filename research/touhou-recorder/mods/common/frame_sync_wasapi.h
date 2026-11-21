#pragma once
#include <windows.h>

namespace autoplay {

// FRAME_SYNC_AUDIOが設定されていれば仮想WASAPIミキサを有効化する(DllMainから呼び出す)。
// ローダーロック回避のため、この時点ではCreateFileやLogを実行しない。
bool InstallFrameSyncWasapi();
bool FrameSyncWasapiActive();

// CoCreateInstance(CLSID_MMDeviceEnumerator) で得たオブジェクトをフックする。
void HookMMDeviceEnumeratorForFrameSync(void* enumerator);

// 1映像フレーム(1/60s = 44100/60 = 735サンプル)分の仮想音声を消費してファイルへ書く。
void FrameSyncWasapiMixFrame(bool write);
void FrameSyncWasapiClose();

// WASAPIスレッドからのSleep()を検出し、仮想バッファ満杯時は次フレームまで待機、
// 空きがあれば即座に返してリフィルさせる。対象スレッドで処理したらtrue。
bool FrameSyncWasapiHandleSleep(DWORD ms);

}  // namespace autoplay
