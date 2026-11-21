#pragma once
#include <windows.h>

// D3DXLoadSurfaceFromMemory の縮小フィルタを補う IAT フック(reports/101)。
//
// 背景: th13 等は会話文・スペルカード名を GDI で 1024x129 の 16bpp DIB(A4R4G4B4 相当、
// 文字の形はアルファの 0/F だけに載る)へ 32px で描き、D3DXLoadSurfaceFromMemory で
// 縮小しながら 512x128 等のテクスチャへ転送する。Windows のネイティブ d3dx9_43 は
// 指定フィルタ(BOX/TRIANGLE/LINEAR)で平均化するので縁が滑らかになるが、Wine の内蔵
// d3dx9 は「LINEAR/TRIANGLE/BOX が未実装のため常に point filter」(dlls/d3dx9_36/surface.c、
// Wine 9.0。master でも BOX はちょうど半分かつ2のべき乗の場合のみ)で間引くため、
// 文字がジャギーになる。
//
// 環境変数:
//   D3DX_LOAD_PROBE=1   呼び出しの引数(フィルタ・矩形・形式)を先頭 200 件ログに記録する。
//   D3DX_AREA_FILTER=1  縮小を伴いフィルタが LINEAR/TRIANGLE/BOX の呼び出しを、MOD 側で
//                       縮小して転送先と同じサイズの A8R8G8B8 に作り直し、D3DX_FILTER_NONE で
//                       元の関数へ渡す。対応外の形式はそのまま元の関数へ渡す。
//   D3DX_AREA_FILTER_RADIUS=<f>  縮小カーネル。既定 0.8 = 半径 0.8×縮小率のテント(ネイティブ
//                       d3dx9_43 の TRIANGLE に最も近かった)。0 なら面積平均。
//   D3DX_DUMP_DIR=<Windowsパス>  拡大縮小を伴う転送の転送元と、転送後の転送先(LockRect で
//                       読み戻し)を先頭 20 回分ファイルに書き出す(ネイティブ d3dx9 との比較用)。
//   D3DX_TIMING=1       import している d3dx9 の関数すべての呼び出し回数・合計/最大時間を
//                       10 秒ごとにログに出す(案A・案Bの負荷の比較用)。
// いずれも未設定なら何もしない。

namespace autoplay {

// DLL_PROCESS_ATTACH で呼ぶ。フックした関数の数を返す。
int InstallD3DXFilterHook();

} // namespace autoplay
