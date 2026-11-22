#pragma once

// D3D8 (th09) 向けフレーム同期キャプチャの初期化。

namespace autoplay {

// FRAME_SYNC_PIPE が未設定なら何もせず false を返す。
bool InstallFrameSyncD3D8(int stepDiv = 32);

}  // namespace autoplay
