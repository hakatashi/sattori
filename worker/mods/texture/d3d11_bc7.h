// BC7テクスチャをロード時にRGBA8へ展開するD3D11フック(reports/96)。
// llvmpipe/lavapipeはBC7のサンプリングが極端に遅いため、CPU描画で録画するときだけ使う。
#pragma once

namespace autoplay {

// 環境変数 D3D11_DECODE_BC7=1(core/runtime_config.h)のときだけフック版を返す。それ以外はrealを
// そのまま返す。GetProcAddress経由で使う(core/pe_iat.h の procaddr::Override)。
void *WrapD3D11CreateDeviceForBc7(void *real);
void *WrapD3D11CreateDeviceAndSwapChainForBc7(void *real);

}  // namespace autoplay
