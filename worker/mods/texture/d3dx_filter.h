#pragma once
#include <windows.h>

// D3DXLoadSurfaceFromMemory の縮小フィルタを補う IAT フック(文字のジャギー対策、
// touhou-recorder reports/101・102 の案A)。
//
// 背景: th10・th11・th12・th128・th13 は会話文・スペルカード名を GDI で2倍の大きさの
// 16bpp DIB(A4R4G4B4 相当、文字の形はアルファの 0/F だけに載る)へ描き、
// D3DXLoadSurfaceFromMemory(D3DX_FILTER_TRIANGLE)で縮小しながらテクスチャへ転送する。
// Windows のネイティブ d3dx9 は指定フィルタで平均化するので縁が滑らかになるが、Wine の
// 内蔵 d3dx9 は LINEAR/TRIANGLE/BOX が未実装で常に最近傍で間引くため、文字がジャギーになる。
//
// このフックは縮小を伴いフィルタが LINEAR/TRIANGLE/BOX の呼び出しだけを MOD 側で縮小し
// (半径 0.8×縮小率のテント。ネイティブ d3dx9_43 の TRIANGLE に最も近かった)、
// 転送先と同じサイズにしてから D3DX_FILTER_NONE で元の関数へ渡す。対応外の形式は
// そのまま元の関数へ渡す。文字列の更新時にしか呼ばれず、1回 0.3ms 程度で現行の
// 最近傍縮小と同じ負荷(reports/101 §10)。
//
// 既定で有効。比較用に環境変数 D3DX_AREA_FILTER=0 で無効にできる(フックしない)。
// th15 は内部解像度 1280x960 では縮小転送が起きないため組み込んでいない(reports/102)。

namespace autoplay {

// DLL_PROCESS_ATTACH で呼ぶ。フックした関数の数を返す。
int InstallD3DXFilterHook();

} // namespace autoplay
