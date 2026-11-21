#pragma once
#include <windows.h>

// Present のイベントバス(Issue #393)。
//
// D3D8・D3D9・DXGI の Present フック(present/d3d8.cpp・d3d9.cpp・dxgi.cpp)は薄いアダプタで、
// Present の前後に、登録された処理(ハンドラ)を優先度の順に呼ぶだけ。何をするかはハンドラが決める:
//   - present/limiter: Present の上限(目標fps)。倍速録画の実装基盤
//   - #388 のフレーム同期: バックバッファの取り込み・上限の解除・Present の省略
//
// 前のハンドラは flags を書き換えて、その回の Present の扱いを決める:
//   kThrottle  上限の待ち(present/limiter)を行う。既定で立っている。フレーム同期のように
//              自分で速度を決めるハンドラは、limiter より前(優先度が小さい)で落とす
//   kSkip      本来の Present(画面への転送)を呼ばない(戻り値は S_OK)
// 後のハンドラは、前のハンドラが決めた flags と Present の戻り値を受け取る。
//
// ハンドラの登録とアダプタの組み込みは DllMain(単一スレッド)で行うこと。Present はゲームの
// 描画スレッドから呼ばれ、登録表はロックなしで読む。

namespace autoplay::present {

enum class Api { kD3D8, kD3D9, kDxgi };

enum Flags : unsigned {
    kThrottle = 1u,
    kSkip = 2u,
};

struct Frame {
    Api api;
    // IDirect3DDevice8* / IDirect3DDevice9* / IDXGISwapChain*
    void* target;
    // DXGI の SyncInterval(前のハンドラが書き換えてよい)。D3D8/D3D9 では null。
    UINT* syncInterval;
};

using PreHandler = void (*)(const Frame& frame, unsigned& flags);
using PostHandler = void (*)(const Frame& frame, unsigned flags, HRESULT hr);
// デバイス(D3D8/D3D9)・スワップチェーン(DXGI)ができたとき。
using DeviceHandler = void (*)(Api api, void* target);

// 優先度。小さいほど先に呼ばれる(前・後とも同じ順)。
constexpr int kPriorityFrameSync = 50;
constexpr int kPriorityLimiter = 100;

void AddPreHandler(PreHandler handler, int priority);
void AddPostHandler(PostHandler handler, int priority);
void AddDeviceHandler(DeviceHandler handler);

// アダプタを組み込む(冪等)。IATを書き換えるので DLL_PROCESS_ATTACH の最初期に呼ぶこと。
// exe の IAT に該当の関数が無ければ false。
bool InstallD3D9();  // d3d9.dll!Direct3DCreate9
bool InstallD3D8();  // d3d8.dll!Direct3DCreate8

// DXGI(D3D11)。DXライブラリ(th06nc)は D3D11 の関数を GetProcAddress で取得するので、
// IATではなく core/pe_iat.h の procaddr::Override からこれらを使う。**#388 で初めて使う
// 予定で、まだどのタイトルにも組み込んでいない(実機で未検証)。**
void* WrapD3D11CreateDeviceAndSwapChain(void* real);
void* WrapD3D11CreateDevice(void* real);
void HookDxgiFactory(void* factory);
void HookDxgiSwapChain(void* swapChain);

// アダプタから呼ぶ。
unsigned DispatchPre(const Frame& frame);
void DispatchPost(const Frame& frame, unsigned flags, HRESULT hr);
void DispatchDevice(Api api, void* target);

}  // namespace autoplay::present
