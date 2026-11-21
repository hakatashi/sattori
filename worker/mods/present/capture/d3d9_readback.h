#pragma once

// D3D9 タイトル向けフレーム同期キャプチャの初期化。

namespace autoplay {

// FRAME_SYNC_PIPE が未設定なら何もせず false を返す。
bool InstallFrameSyncD3D9(int stepDiv = 1024);

}  // namespace autoplay
