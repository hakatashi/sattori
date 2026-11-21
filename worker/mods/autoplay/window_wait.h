#pragma once
#include <windows.h>

namespace autoplay {

// どのウィンドウをゲームのメインウィンドウとみなすか。
enum class WindowFilter {
    // 可視・トップレベル・タイトルバー付き(32bitタイトル)
    kDefault,
    // kDefault に加え、起動ダイアログ(クラス #32770)とクライアント幅320未満を除く
    // (th06c/th06nc の DXライブラリ。th06cの解像度選択ダイアログ(194x317)を誤認しないため)
    kDxlib,
};

// pid の可視トップレベルウィンドウが出現し、stableMs の間 HWND が変化しなく
// なるまで待つ (東方タイトルの多くは起動直後にウィンドウを再作成するため)。
// timeoutMs 経過した場合はその時点で見つかっている HWND (NULL の場合もある)
// を返す。安定したときの行(core/log_contract.h の kWindowStableFmt)は録画パイプラインが
// 録画開始の合図として待っている。
HWND WaitForStableWindow(DWORD pid, unsigned int stableMs, unsigned int timeoutMs,
                         WindowFilter filter = WindowFilter::kDefault);

} // namespace autoplay
