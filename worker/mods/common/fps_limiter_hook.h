#pragma once
#include <windows.h>

// Direct3D9 IDirect3DDevice9::Present の vtable フックによるフレームレート制限。
//
// フック連鎖:
//   IAT フック: d3d9.dll!Direct3DCreate9
//     -> vtable フック: IDirect3D9::CreateDevice (vtable[16])
//       -> vtable フック: IDirect3DDevice9::Present (vtable[17])
//
// 背景: th20をAWS EC2(Intel Xeon, Nitro/KVM仮想化環境)で録画すると、ゲーム内蔵
// fpsカウンターが常時75fps前後(本来60fps)となり、リプレイが実時間より早回しに
// なる不具合が発覚した(フェーズ46追加調査)。調査の結果、
//   - wineのSleep/QueryPerformanceCounter/GetTickCount自体は当該AWS環境でも
//     正確であることを自作テストバイナリで確認済み(問題はwineのntdll層ではない)
//   - strace観測で、th20.exeのフレームループが要求するpselect6の待機時間
//     (5〜8ms程度)自体が、60fps(16.67ms/フレーム)を維持するには短すぎることを
//     確認した。ローカル実機(Ryzen 7 5700X)ではこの待機時間計算が正しく機能し
//     常時60.0〜60.4fpsに収束するが、AWS環境ではXvfb+wined3d+llvmpipe経由の
//     間接GLXレンダリング(DRI3非対応環境でのMesa内部のフレームペーシング、
//     もしくはth20自体のフレームカウント基準のロジック更新)が環境依存で
//     ズレるため、th20はレンダリングfpsとゲーム内ロジック更新が直結しており
//     (th08のようなdelta-time方式ではない)、fpsが上振れするとゲーム進行速度
//     自体も比例して早くなることを実測(4xlargeで総録画時間がローカルより
//     約18%短縮)で確認した
//   - Linux側のLD_PRELOADによるglXSwapBuffersフックはwineのプロセスローダーが
//     LD_PRELOADを継承しないため効果が無かった(th20.exeプロセス内で一切
//     呼ばれないことを診断ログで確認済み)
//
// 対策として、th20.exe自身にIAT/vtableフックで注入した本フックにより、
// IDirect3DDevice9::Present呼び出しをQueryPerformanceCounter基準で
// 目標fps(既定60、環境変数FPS_LIMIT_TARGET_HZで変更可)に強制的にスロットルする。
// QueryPerformanceCounterはwine層で実測済みに正確なため、環境非依存で信頼できる
// 基準として使える。

namespace autoplay {

// InstallFpsLimiterHook() は DLL_PROCESS_ATTACH の最初期(ゲームが
// Direct3DCreate9 を呼ぶ前)に呼ぶこと。IATを走査して書き換えるだけの処理なので、
// ローダーロック下でも安全に実行できる。targetHzは既定のPresent呼び出し
// 上限レート(環境変数FPS_LIMIT_TARGET_HZが設定されていればそちらを優先)。
bool InstallFpsLimiterHook(double targetHz = 60.0);

} // namespace autoplay
