#pragma once
#include <windows.h>

namespace autoplay {

// 64bit DXライブラリ (D3D11/DXGI + WASAPI) 向けフレーム同期キャプチャ(reports/112)。
// DllMain(DLL_PROCESS_ATTACH) から呼ぶ。FRAME_SYNC_PIPE 未設定時は no-op。
// th06nc のローダーロック制約のため、DllMain 内ではログ出力・CreateFile・スレッド生成を行わない。
bool InstallFrameSyncD3D11(int stepDiv = 64);

bool FrameSyncD3D11Active();
void FrameSyncD3D11SetUnthrottled(bool unthrottled);
void FrameSyncD3D11SleepMs(DWORD ms);
void FrameSyncD3D11WaitPresentFrames(int frames);

// KERNEL32!GetProcAddress 経由で動的解決される API 向けラッパ(未有効時は real をそのまま返す)。
void* WrapQPCForFrameSync(void* real);
void* WrapTimeGetTimeForFrameSync(void* real);
void* WrapGetTickCountForFrameSync(void* real);
void* WrapGetTickCount64ForFrameSync(void* real);
void* WrapSleepForFrameSync(void* real);
void* WrapWaitForSingleObjectForFrameSync(void* real);
void* WrapD3D11CreateDeviceForFrameSync(void* real);
void* WrapD3D11CreateDeviceAndSwapChainForFrameSync(void* real);
void* WrapCreateDXGIFactoryForFrameSync(void* real);
void* WrapCreateDXGIFactory1ForFrameSync(void* real);
void* WrapCreateDXGIFactory2ForFrameSync(void* real);

}  // namespace autoplay
