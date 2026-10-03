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
//
// 【倍速録画(issue #1)で確認済みの重要事項】プライマリバッファには触らないこと:
// フェーズ85では「セカンダリを88200Hzに上げてもプライマリが44100Hzのままだと
// ミックス時にロールオフされる」という仮説から、プライマリバッファの
// GetFormat/SetFormat(vtable[5]/[14])と SetCooperativeLevel(vtable[6])を
// フックする実装を入れたが、**Wineでは原理的に効果が無いことをソースコードと
// 実測の両面から確認したため撤去した**(reports/86 §2.2)。
//
//   - `dlls/dsound/primary.c` の primarybuffer_SetFormat() は、協調レベルが
//     DSSCL_WRITEPRIMARY のときだけ DSOUND_ReopenDevice(device, TRUE) を呼んで
//     実際の出力ストリームを開き直す。DSSCL_PRIORITY では device->primary_pwfx に
//     値を控えるだけで実ストリームは一切変わらない(戻り値は S_OK)。
//   - DSSCL_WRITEPRIMARY へ底上げすると、`dlls/dsound/mixer.c` がセカンダリ
//     バッファを一切ミックスしなくなる(=ゲーム音声が無音になる)ため使えない。
//
// 正しい介入点はMOD側ではなく録画側で、**ゲームプロセスに渡す PULSE_SINK を
// 倍速後のレート(44100×N Hz)のnull-sinkに向けること**(recorder/instance.py の
// ensure_audio_sink())。WineのWASAPIミックスフォーマットはPulseAudioのシンクの
// レートをそのまま採用するため、これでdsoundのミキサーのリサンプル自体が消える。

namespace autoplay {

// InstallDSoundHook() は DLL_PROCESS_ATTACH の最初期(ゲームが
// DirectSoundCreate8 を呼ぶ前)に呼ぶこと。freqScale はセカンダリバッファの
// 再生周波数に掛ける係数(環境変数FPS_LIMIT_TARGET_HZが設定されていれば
// target/60.0を優先、未設定なら1.0=無変更)。
bool InstallDSoundHook(double freqScale = 1.0);

// DirectSoundをIATではなくGetProcAddress/CoCreateInstanceで取得するエンジン
// (DXライブラリ製のth06nc、reports/89)向けの入口。InitDSoundHookDynamic()で倍率の決定と
// 同期マーカーの準備だけを行い、呼び出し側のGetProcAddressフックで
// "DirectSoundCreate8" の戻り値を WrapDirectSoundCreate8() に差し替えるか、
// CoCreateInstanceで作られたIDirectSound(8)を HookDirectSoundObject() に渡す。
void InitDSoundHookDynamic(double freqScale = 1.0);
void* WrapDirectSoundCreate8(void* real);
void HookDirectSoundObject(void* ds8);

} // namespace autoplay
