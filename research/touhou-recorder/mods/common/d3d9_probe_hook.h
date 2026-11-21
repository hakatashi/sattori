#pragma once
#include <windows.h>

// Direct3D9の描画内容を記録する診断用フック(reports/99)。
//
// th06ncではVulkanレイヤーで描画の中身を調べ、BC7テクスチャが律速だと特定した(reports/96)。
// D3D9のタイトル(th15・th20)はwined3d(OpenGL)経路でVulkanを通らないため、同じことを
// IDirect3DDevice9のvtableフックで行う。
//
// 環境変数 D3D9_PROBE=1 のときだけ有効。InstallFpsLimiterHook()が生成したデバイスを
// コールバックで受け取り、次のメソッドを包む:
//   CreateTexture/CreateRenderTarget/CreateDepthStencilSurface/CreateVertexBuffer(生成のログ)
//   SetRenderTarget/SetTexture/SetRenderState/SetSamplerState/SetPixelShader/SetVertexShader/SetFVF(状態の追跡)
//   Clear/StretchRect/ColorFill/DrawPrimitive/DrawIndexedPrimitive/DrawPrimitiveUP/DrawIndexedPrimitiveUP(集計)
//   Present(フレーム境界)
//
// 出力(MODのログへ):
//   - D3D9_PROBE_SUMMARY_FRAMES(既定300)フレームごとに、1フレームあたりの描画コール数・頂点数等
//   - D3D9_PROBE_DUMP_EVERY(既定1800)フレームごとに1フレームを詳しく記録する。描画ごとに
//     D3DQUERYTYPE_OCCLUSIONで通過サンプル数(=おおよその塗りつぶしピクセル数)を測り、
//     (描画先サイズ, テクスチャ形式・サイズ, ブレンド, シェーダー有無, FVF)ごとにまとめる。
//     クエリの分だけそのフレームは遅くなる。
//
// 実験用に、環境変数 D3D9_PROMOTE_A4R4G4B4=1 で、D3DXCreateTexture/
// D3DXCreateTextureFromFileInMemoryExが作るA4R4G4B4テクスチャをA8R8G8B8へ格上げする
// (D3D9_PROBEとは独立。書き込みはD3DXLoadSurfaceFrom*が転送先の形式へ変換する)。

namespace autoplay {

// DLL_PROCESS_ATTACHでInstallFpsLimiterHook()より前に呼ぶ。D3D9_PROBEが未設定なら何もしない。
void InstallD3D9ProbeHook();

// fps_limiter_hookのCreateDevice成功時に呼ばれる(未登録ならnullptr)。
extern void (*g_d3d9DeviceCreatedCallback)(void* device);

} // namespace autoplay
