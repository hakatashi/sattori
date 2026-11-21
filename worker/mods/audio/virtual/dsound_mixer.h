#pragma once

// DirectSound タイトル向けフレーム同期用仮想音声ミキサ。

namespace autoplay::audio::dsound_mixer {

// FRAME_SYNC_AUDIO が設定されている場合のみ有効化して true を返す。
bool Install();
bool Active();

}  // namespace autoplay::audio::dsound_mixer
