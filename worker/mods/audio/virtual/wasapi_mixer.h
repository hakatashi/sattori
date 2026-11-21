#pragma once

// 64bit DXライブラリ (WASAPI 共有モード) 向けフレーム同期用仮想音声ミキサ。

namespace autoplay::audio::wasapi_mixer {

// FRAME_SYNC_AUDIO が設定されている場合のみ有効化して true を返す(ローダーロック安全)。
bool Install();
bool Active();

// CoCreateInstance で得られた IMMDeviceEnumerator に GetDefaultAudioEndpoint / GetDevice を入れる。
void HookMMDeviceEnumerator(void* enumerator);

}  // namespace autoplay::audio::wasapi_mixer
