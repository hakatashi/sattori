#pragma once

// MODログのうち、ワーカー(Python)が正規表現・部分一致で読む行の書式(契約)。
//
// **ここにある書式を変えるときは、読む側も同時に直すこと。** 読む側と、契約を確かめるテスト:
//   - worker/recording/modlog.py   MENU_STEP_LOG_RE・SEQUENCE_COMPLETE_LOG・SCORE_MONITOR_RE・
//                                  _LOG_LINE_TIME_RE・_SYNC_MARKER_EPOCH_RE
//   - worker/recording/sync_marker.py  GAME_READY_LOG・_MARKER_RE
//   - worker/recording/pipeline.py     "WaitForStableWindow: stable"・"sequence complete"の待ち
//   - mods/tests/test_log_contract.cpp  この書式で mods/tests/log_contract_golden.txt を再現できるか
//   - worker/tests/test_mod_log_contract.py  上のゴールデンを Python の正規表現で読めるか
//
// ホストの g++ でもコンパイルできるよう、Win32 に依存しないこと。

namespace autoplay::log_contract {

// 行頭の時刻(GetLocalTime、日付なし・ミリ秒)。modlog.py の _LOG_LINE_TIME_RE。
inline constexpr const char* kLinePrefixFmt = "[%02d:%02d:%02d.%03d] ";

// メニュー操作のキーを押す直前の行。modlog.py の MENU_STEP_LOG_RE(`\] Step \d+: `)。
inline constexpr const char* kStepFmt = "Step %d: %s";

// メニュー操作の完了。pipeline.py が部分一致("sequence complete")で待つ。
inline constexpr const char* kSequenceCompleteFmt = "=== %s_replay_autoplay: sequence complete ===";

// ゲームウィンドウの安定。pipeline.py・sync_marker.py が部分一致("WaitForStableWindow: stable")で待つ。
inline constexpr const char* kWindowStableFmt = "WaitForStableWindow: stable after %lu ms total";

// スコア監視(Issue #103)。modlog.py の SCORE_MONITOR_RE。
inline constexpr const char* kScoreMonitorFmt =
    "ScoreMonitor: score=%llu stage=%d lives=%d graze=%d epoch_ms=%llu";

// 同期マーカー(touhou-recorder reports/88)。sync_marker.py の _MARKER_RE。
inline constexpr const char* kSyncMarkerPlayedFmt =
    "SYNC_MARKER played epoch=%.6f play_call_sec=%.6f rate=%lu samples=%lu amp=%d seed=0x%08lX "
    "hr=0x%08lX";

// フレーム同期キャプチャ(touhou-recorder reports/104〜112)。
inline constexpr const char* kFrameSyncCaptureStartFmt =
    "FrameSync: capture start width=%u height=%u d3dfmt=%lu pix_fmt=%s multisample=%lu";
inline constexpr const char* kFrameSyncCaptureStoppedFmt =
    "FrameSync: capture stopped frames_written=%lld present_count=%lld "
    "frames_with_live_threads=%lld throttle_while_threads=%d";
inline constexpr const char* kFrameSyncUnthrottledFmt = "FrameSync: unthrottled=%d at frame=%lld";

}  // namespace autoplay::log_contract
