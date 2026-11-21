#pragma once
#include <windows.h>

// exe のコードの書き換え(バイト照合つき)。th12 の fps 表示の補正(コードケーブ)で使う。
//
// 書き換える前に、対象の位置のバイト列が想定どおりか必ず確かめること(Matches)。ゲームの版が
// 変わってコードがずれた exe では何もしない(誤った位置を書き換えるとゲームごと落ちる)。

namespace autoplay::code_patch {

// exe の rva から len バイトが expected と一致するか。
bool Matches(ULONG_PTR rva, const BYTE* expected, size_t len);

// exe 内の rva のアドレス。
BYTE* At(ULONG_PTR rva);

// 実行可能なメモリ(コードケーブ)を確保する。失敗したら null。
BYTE* AllocCave(size_t size);

// p に `jmp target`(e9 rel32、5バイト)を書き、書いた次の位置を返す。
BYTE* EmitJmp(BYTE* p, const BYTE* target);

// site の先頭 len バイト(5以上)を `jmp target` + nop で潰す(保護の付け外しと命令キャッシュの
// フラッシュも行う)。
void RedirectTo(BYTE* site, size_t len, const BYTE* target);

}  // namespace autoplay::code_patch
