#pragma once
#include <windows.h>
#include "audio/sync_marker_sequence.h"

// 同期マーカー(A/V同期補正、touhou-recorder reports/88)の共通部。音を出すのは
// audio/dsound(DirectSoundのバッファを作って鳴らす)と audio/wasapi(ゲームの出力バッファへ
// 足し込む)で、ここはトリガーファイルの監視・時刻・ログ行だけを持つ(Issue #393 で1本にした)。
//
// 録画パイプラインが音声録音を開始した後にトリガーファイル(SYNC_MARKER_TRIGGER)を置くと、
// ゲーム自身の音声デバイスから低レベルの疑似乱数ノイズ(audio/sync_marker_sequence.h)を1回だけ
// 鳴らし、鳴らし始めた壁時計時刻(UNIX epoch秒)をログへ出す。録画後に
// worker/recording/sync_marker.py が同じ系列を相互相関で探し、「音声ファイル上の位置 ↔ 発音を
// ゲームが指示した時刻」の対応を直接求める。

namespace autoplay::sync_marker {

// 壁時計(UNIX epoch秒、GetSystemTimePreciseAsFileTime)。スピードハックの対象外。
double EpochNow();

// 鳴らし始めたときの契約行(core/log_contract.h の kSyncMarkerPlayedFmt)。
void LogPlayed(double epoch, double playCallSec, DWORD rate, HRESULT hr);

struct Watch {
    // ログの接頭辞("SyncMarker" / "SyncMarker(WASAPI)")
    const char* tag;
    // 鳴らせる状態か(null なら常に true)。偽の間はトリガーがあっても待つ。
    bool (*ready)();
    // トリガーを見つけたときに監視スレッドから1回だけ呼ぶ。
    void (*onTrigger)();
    // 上限まで待ってもトリガーが無かったときにログを出すか
    bool logTimeout;
};

// SYNC_MARKER_TRIGGER(core/runtime_config.h)のファイルを監視するスレッドを起動する。
// 未設定なら何もせず false。armedBy はログに出す呼び出し元の名前。
bool Arm(const Watch& watch, const char* armedBy);

}  // namespace autoplay::sync_marker
