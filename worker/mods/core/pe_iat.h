#pragma once
#include <windows.h>

// PEのインポートテーブル(IAT)の書き換え(Issue #393 で10か所のコピーを1つにした)。
//
// どれも DLL_PROCESS_ATTACH の最初期(ゲームが対象の関数を呼ぶ前)に呼ぶこと。IATを走査して
// 書き換えるだけなので、ローダーロック下でも安全に実行できる。
//
// 同じ関数を2回フックすると、2回目の *orig は1回目のフック関数になり、呼び出しが
// 2回目 → 1回目 → 本物 の順に連なる(clock/fps_display は clock/speed_hack の外側に入る前提で
// これを使っている)。

namespace autoplay::iat {

// 序数でインポートされた関数(dsound.dll!DirectSoundCreate8 = 11 など)。
struct Ordinal {
    WORD value;
};
// 名前がこの文字列で始まるDLL(d3dx9_31.dll / d3dx9_43.dll のようにタイトルで版が違うもの)。
struct DllPrefix {
    const char* value;
};

// module のIATで dll!name を fn に差し替え、元の関数を *orig に入れる(orig は null 可)。
// module が null なら exe 自身。見つからなければ false。
bool Hook(HMODULE module, const char* dll, const char* name, void* fn, void** orig);
bool Hook(HMODULE module, const char* dll, Ordinal ordinal, void* fn, void** orig);
// matchedDll には実際に一致したDLL名(IATの文字列)を返す(null 可)。
bool Hook(HMODULE module, DllPrefix dll, const char* name, void* fn, void** orig,
          const char** matchedDll = nullptr);

// 関数ポインタ型を保ったまま呼ぶ版。
template <typename Key, typename F>
bool HookTyped(HMODULE module, const char* dll, Key key, F fn, F* orig) {
    return Hook(module, dll, key, (void*)fn, (void**)orig);
}

}  // namespace autoplay::iat

// GetProcAddress の横取り(th06c/th06nc の DXライブラリは入力・時刻・音声・D3D11の関数を
// LoadLibrary + GetProcAddress で動的に取得するので、IATではなくここで差し替える)。
//
// Override() で「関数名 → 差し替え関数」を登録し、Install() で exe の
// KERNEL32!GetProcAddress を横取りする。同じ名前に複数登録すると登録順に連なる
// (wrap2(wrap1(real)))。序数での取得は横取りしない。
namespace autoplay::procaddr {

// real(本物の関数、取得に失敗していれば null)を受け取り、ゲームへ返す関数を返す。
using Wrap = void* (*)(void* real);

// evenIfNull: 本物が null(取得失敗)でも wrap を呼ぶか。既定では呼ばない(差し替えると
// 呼び出し時に null の元関数を呼んでしまう)。入力の関数のように、本物が無くても
// 自前の関数を返したいものだけ true にする。
void Override(const char* name, Wrap wrap, bool evenIfNull = false);

// exe の IAT の KERNEL32!GetProcAddress を横取りする。
bool Install(HMODULE module = nullptr);

}  // namespace autoplay::procaddr
