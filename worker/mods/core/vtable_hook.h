#pragma once
#include <windows.h>

// COMオブジェクトの vtable の書き換え(Issue #393 で7か所のコピーを1つにした)。
//
// **冪等**: vtable[index] がすでに hook なら何もせず false を返す。Wine の実装では同じ型の
// オブジェクト(キーボードとマウスのデバイス、2回目の DirectInput8Create など)が1つの静的な
// vtable を共有しているので、確かめずに2回パッチすると *orig に hook 自身が入り、次の呼び出しで
// 無限再帰(スタックオーバーフロー)になる(th20の2回目の DirectInput8Create で起きた、
// touhou-recorder reports/44)。かつてはこの確認を呼び出し側の注意だけで防いでいた。
//
// 元の関数は型付きで *orig に入れる(呼び出し側が void** へのキャストを書かずに済む)。

namespace autoplay::vtable {

inline void** Of(void* obj) { return *(void***)obj; }

// vt[index] を hook に差し替え、元の関数を *orig に入れる。差し替えたら true。
template <typename F>
bool Hook(void** vt, int index, F hook, F* orig) {
    void* h = (void*)hook;
    if (vt[index] == h) return false;
    DWORD oldProt;
    VirtualProtect(&vt[index], sizeof(void*), PAGE_EXECUTE_READWRITE, &oldProt);
    *orig = (F)vt[index];
    vt[index] = h;
    VirtualProtect(&vt[index], sizeof(void*), oldProt, &oldProt);
    return true;
}

// オブジェクトの vtable を書き換える版。
template <typename F>
bool HookObject(void* obj, int index, F hook, F* orig) {
    return Hook(Of(obj), index, hook, orig);
}

}  // namespace autoplay::vtable
