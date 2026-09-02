#pragma once
#include <windows.h>

// Direct3D8 IDirect3DDevice8::Present の vtable フックによるフレームレート制限。
//
// mods/common/fps_limiter_hook.h(Direct3D9版、th10/th12/th20で使用)のD3D8版。
// th09(2005年、thprac_th09.cppのGameGuiInitがIMPL_WIN32_DX8を指定)はDirectX8
// エンジンのため、d3d9.dll!Direct3DCreate9を前提とするD3D9版フックは使えない
// (IAT上にDirect3DCreate9のエントリが存在しないため無効化されるだけで実害は
// 無いが、そもそも目的を達成できない)。フェーズ68で新規追加。
//
// フック連鎖:
//   IAT フック: d3d8.dll!Direct3DCreate8
//     -> vtable フック: IDirect3D8::CreateDevice (vtable[15])
//       -> vtable フック: IDirect3DDevice8::Present (vtable[15])
//
// vtable番号の根拠(d3d8.h、DirectX8 SDK):
//   IDirect3D8は IUnknown(3) + RegisterSoftwareDevice/GetAdapterCount/
//   GetAdapterIdentifier/GetAdapterModeCount/EnumAdapterModes/
//   GetAdapterDisplayMode/CheckDeviceType/CheckDeviceFormat/
//   CheckDeviceMultiSampleType/CheckDepthStencilMatch/GetDeviceCaps/
//   GetAdapterMonitor(12個)の後にCreateDevice、よって0-indexedで15。
//   D3D9のIDirect3D9はこれに加えてCheckDeviceFormatConversionが1つ多いため
//   CreateDeviceは16(mods/common/fps_limiter_hook.cppのコメント参照)。
//   IDirect3DDevice8は IUnknown(3) + TestCooperativeLevel/
//   GetAvailableTextureMem/ResourceManagerDiscardBytes/GetDirect3D/
//   GetDeviceCaps/GetDisplayMode/GetCreationParameters/SetCursorProperties/
//   SetCursorPosition/ShowCursor/CreateAdditionalSwapChain/Reset(12個)の後に
//   Presentのため0-indexedで15。D3D9のIDirect3DDevice9はこれに加えて
//   GetSwapChain/GetNumberOfSwapChainsが2つ多いためPresentは17
//   (fps_limiter_hook.cpp参照)。
//
// 実装ロジック(QueryPerformanceCounter基準のPresent間引き)は
// fps_limiter_hook.cppと同一。

namespace autoplay {

// InstallFpsLimiterHookD3D8() は DLL_PROCESS_ATTACH の最初期(ゲームが
// Direct3DCreate8 を呼ぶ前)に呼ぶこと。targetHzは既定のPresent呼び出し
// 上限レート(環境変数FPS_LIMIT_TARGET_HZが設定されていればそちらを優先)。
bool InstallFpsLimiterHookD3D8(double targetHz = 60.0);

} // namespace autoplay
