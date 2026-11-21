#pragma once
#include <windows.h>

// GDI フォント生成 API (CreateFont/CreateFontIndirect系) の IAT フック。
//
// 目的: th11(および同系エンジン)の文字輪郭がWindows実機よりジャギーな問題
// (reports/38, 39参照)の原因切り分け用診断ツール。
//
// フェーズ39での調査で、th11は既に明示的にANTIALIASED_QUALITY(lfQuality=4)で
// MS Gothic/MS Minchoを生成していることをこのフック自身のログで確認した
// (DEFAULT_QUALITYではなかった)。またlfQualityをCLEARTYPE_QUALITYへ強制すると
// Wineのサブピクセルレンダリング経路(色収差を伴う)は起動するが、実機との
// 輪郭差(グレースケール階調の幅)自体は改善しないこともスキャンライン単位の
// 画素値比較で確認済み。つまりlfQuality経由の対策では実機同等の見た目には
// ならない(詳細はreports/39参照)。
//
// 現時点では「ゲームが実際にどのlfQualityでGDIフォントを生成しているか」を
// 確認する診断目的でのみ有用(呼び出しがログに出るかどうかで、GDI経由の
// テキスト描画かビットマップ直接合成かの切り分けにも使える)。

namespace autoplay {

// forcedQuality にこの値を渡すと lfQuality の書き換えを行わず、呼び出しの
// ログ記録のみ行う(診断目的)。
const BYTE FONT_QUALITY_NO_OVERRIDE = 0xFF;

// dllName="gdi32.dll" 配下の CreateFontA/W, CreateFontIndirectA/W,
// CreateFontIndirectExA/W をフックし、生成されるすべてのフォントの lfQuality
// を forcedQuality に書き換える。DLL_PROCESS_ATTACH の最初期に呼ぶこと。
// 実際にフックできた関数の数を返す(0ならGDI経由のフォント生成をしていない
// 可能性が高い)。
int InstallFontQualityHook(BYTE forcedQuality = ANTIALIASED_QUALITY);

} // namespace autoplay
