#pragma once
#include <windows.h>

// WASAPI(IAudioClient)で音声を出すエンジン(DXライブラリ製のth06nc、reports/89)向けの
// 倍速録画対応と A/V 同期マーカー(reports/88)。
//
// 倍速化の仕組み:
//   IAudioClient::GetMixFormat の戻り値のレートを 1/freqScale にしてゲームへ見せ
//   (専用シンク 88200Hz → ゲームには 44100Hz)、ゲームが Initialize に渡すフォーマットの
//   レートを freqScale 倍に戻して実ストリームを開く。ゲームは44100Hz相当の内容を
//   書き込むが、ストリームは88200Hzで消費するので「テープの早回し」と同じく
//   テンポ・ピッチとも freqScale 倍になる(DirectSoundの SetFrequency スケールと同じ結果)。
//   等倍(freqScale=1.0)では何も書き換えない。
//
// 同期マーカー:
//   環境変数 SYNC_MARKER_TRIGGER のファイルが現れたら、次に IAudioRenderClient::ReleaseBuffer
//   されるバッファから、dsound_hook.cpp と同一の系列(xorshift32、振幅256、131072フレーム)を
//   ゲームの音に足し込み、最初のバッファを渡した時刻をログへ出す。ゲームの音と同じ
//   ストリームに乗るので、出力遅延・タイムスタンプのぶれは打ち消される。
//
// 使い方: InstallWasapiHook() を DllMain で呼び、CoCreateInstance(CLSID_MMDeviceEnumerator)
// で得たオブジェクトを HookMMDeviceEnumerator() に渡す。

namespace autoplay {

void InstallWasapiHook(double freqScale = 1.0);
void HookMMDeviceEnumerator(void* enumerator);

} // namespace autoplay
