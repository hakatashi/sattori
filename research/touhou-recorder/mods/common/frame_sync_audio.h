#pragma once
#include <windows.h>

// フレーム同期キャプチャ(reports/105)の音声: MOD内の仮想音声デバイス(reports/106・107)。
//
// フレーム同期キャプチャではゲームが実時間で進まないので、DirectSoundに実際に鳴らさせて
// PulseAudioから録る従来の方法は使えない。代わりに、セカンダリバッファの再生をMODの中で
// 再現し、映像の1フレームにつき735サンプル(44100Hz÷60)をミックスしてファイルへ書く。
//
//   - 中身: Unlockのたびに書かれた範囲を写し(シャドウ)へコピーする。Lock/Unlockは本物へ通す。
//   - 状態: Play・Stop・SetCurrentPosition は本物へ渡さず、仮想の再生状態だけを更新する
//     (本物のバッファは鳴らない)。SetVolume・SetPan・SetFrequency は本物へも渡したうえで控える。
//     GetCurrentPosition・GetStatus は仮想の値を返す(writeカーソルはplayの10ms先)。
//   - 通知: SetNotificationPositions は本物へ渡さずに控え、ミックスで仮想の再生位置が通知位置を
//     越えたらMODが SetEvent する。そのあとゲームの補充スレッドがそのバッファを Unlock するまで
//     (最大 FRAME_SYNC_AUDIO_REFILL_WAIT_MS、既定500ms)待ってから次へ進む。
//   - ミックス: 8/16bit、1/2ch、任意のレートを線形補間で44100Hz・2chへ。音量は10^(v/2000)、
//     パンは反対側を10^(-|pan|/2000)倍。結果は16bitへ丸めて飽和させる。
//
// 環境変数:
//   FRAME_SYNC_AUDIO  出力するPCM(s16le・44100Hz・2ch、ヘッダなし)のWindows形式パス。
//                     未設定なら無効(従来どおり本物のDirectSoundが鳴る)。
//
// MODログ: "FrameSyncAudio: ..."(作成したバッファ、通知の待ちのタイムアウト、停止時の集計)。

namespace autoplay {

// InstallFrameSyncHook() の中から呼ばれる。FRAME_SYNC_AUDIO 未設定なら何もせずfalse。
bool InstallFrameSyncAudio();

bool FrameSyncAudioActive();

// Presentごとにメインスレッドから呼ぶ。1フレームぶん(735サンプル)をミックスし、
// write=trueならファイルへ書く。BGMの通知を出したら補充を待ってから戻る。
void FrameSyncAudioMixFrame(bool write);

// 取り込み停止時に呼ぶ。ファイルを閉じて集計をログへ出す。
void FrameSyncAudioClose();

} // namespace autoplay
