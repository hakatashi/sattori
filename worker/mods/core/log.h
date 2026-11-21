#pragma once
#include <windows.h>

// MODログ(`thNN_autoplay.log`)。ワーカー(Python)が読む行の書式は core/log_contract.h にある。

namespace autoplay {

// hModule 自身の DLL ファイルと同じフォルダに logFileName でログファイルを作る
void LogInit(HMODULE hModule, const char* logFileName);
void Log(const char* fmt, ...);

// 契約行(core/log_contract.h)を出す。書式をタイトルごとに書かないこと。
//   LogStep: メニュー操作のキーを押す**直前**に出す。最後のStep行が「再生を確定したキー」になる
//            (worker/recording/modlog.py の find_replay_start_epoch)。
//   LogSequenceComplete: 最後のキーを押し終えてから出す。
void LogStep(int step, const char* fmt, ...);
void LogSequenceComplete(const char* gameId);

} // namespace autoplay
