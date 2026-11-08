// BC7テクスチャをロード時にRGBA8へ展開するD3D11フック(reports/96)。
// llvmpipe/lavapipeはBC7のサンプリングが極端に遅いため、CPU描画で録画するときだけ使う。
#pragma once

// 環境変数 D3D11_DECODE_BC7=1 のときだけフック版を返す。それ以外はrealをそのまま返す。
void *WrapD3D11CreateDevice(void *real);
void *WrapD3D11CreateDeviceAndSwapChain(void *real);
