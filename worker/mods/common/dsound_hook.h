#pragma once
#include <windows.h>

// DirectSound(dsound.dll)の IDirectSoundBuffer::SetFrequency vtable フックによる
// 音声再生速度のスケーリング。
//
// フック連鎖:
//   IAT フック: dsound.dll!DirectSoundCreate8 (Ordinal 11)
//     -> vtable フック: IDirectSound8::CreateSoundBuffer (vtable[3])
//       -> vtable フック: IDirectSoundBuffer::SetFrequency (vtable[17])
//
// 背景: mods/common/fps_limiter_hook.h の FPS_LIMIT_TARGET_HZ でth20の
// Present頻度を意図的に落とすと、th20はレンダリングfpsとゲームロジック更新が
// 直結しているためゲーム進行自体もスローモーション化できる(reports/47参照)。
// しかしBGM/SEはDirectSoundのサウンドバッファ再生(ハードウェアクロック基準の
// 独立したストリーミング)に依存しており、Presentフックの影響を受けず実時間通り
// 再生され続けるため、映像と音声の対応関係がズレていく問題があった。
//
// 対策として、セカンダリサウンドバッファ(BGM/SE、プライマリバッファは除く)の
// 再生周波数(サンプリングレート)自体を同じ比率でスケールする。テープの
// 早回し/遅回しと同じ原理で、周波数を下げれば再生速度もピッチも同じ比率で
// 下がる(ピッチが変わる副作用があるが、録画後にサンプルレートを元の比率に
// リサンプルするだけで速度・ピッチとも完全に復元できる可逆変換のため、
// 音声側の対症療法として現実的)。CreateSoundBuffer直後の初期周波数だけでなく
// SetFrequency自体もフックしているため、ゲームが後から動的に周波数を
// 変更する演出があっても同じ比率でスケールされる。

namespace autoplay {

// InstallDSoundHook() は DLL_PROCESS_ATTACH の最初期(ゲームが
// DirectSoundCreate8 を呼ぶ前)に呼ぶこと。freqScale はセカンダリバッファの
// 再生周波数に掛ける係数(環境変数FPS_LIMIT_TARGET_HZが設定されていれば
// target/60.0を優先、未設定なら1.0=無変更)。
bool InstallDSoundHook(double freqScale = 1.0);

} // namespace autoplay
