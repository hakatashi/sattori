"""MOD統合テストのフレーム同期向け検証関数(`tests/mod_integration/checks.py`)のユニットテスト。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "mod_integration"))
import checks  # noqa: E402

MOD_LOG = """\
[10:00:00.000] FrameSync: capture start width=640 height=480 d3dfmt=22 pix_fmt=bgr0 multisample=0
[10:00:10.000] FrameSync: stats frame=600 written=599 real_ms=10000 fps=60.0
[10:00:11.000] FrameSync: unthrottled=1 at frame=1000
[10:00:12.000] ScoreMonitor: score=100 stage=7 lives=2 graze=5 epoch_ms=1
[10:00:13.000] FrameSync: stats frame=1600 written=1599 real_ms=2000 fps=300.0
[10:00:14.000] ScoreMonitor: score=200 stage=7 lives=1 graze=9 epoch_ms=2
[10:00:15.000] ScoreMonitor: score=300 stage=7 lives=0 graze=12 epoch_ms=3
[10:00:16.000] FrameSync: stats frame=2600 written=2599 real_ms=3000 fps=300.0
[10:00:17.000] FrameSyncAudio: closed frames_written=3000 frames_mixed=3000 notifies=5 refill_timeouts=0 unknown_plays=0
[10:00:17.000] FrameSync: capture stopped frames_written=3000 present_count=3001 frames_with_live_threads=0
"""


def test_frame_at_interpolates_between_anchors():
    anchors = checks.frame_time_anchors(checks.timestamped_lines(MOD_LOG))
    assert checks.frame_at(anchors, 10.0 + 36000 + 1.0) == 1000  # unthrottled行
    assert checks.frame_at(anchors, 36000 + 13.0) == 1600
    assert checks.frame_at(anchors, 36000 + 12.0) == 1000 + 600 * (1 / 2)
    assert checks.frame_at([], 1.0) is None


def test_timestamped_lines_unwraps_midnight():
    text = "[23:59:59.000] a\n[00:00:01.000] b\n"
    lines = checks.timestamped_lines(text)
    assert lines[1][0] - lines[0][0] == 2.0


def test_read_game_hit_times_in_game_seconds():
    # 上限解除(frame=1000)の12秒後の被弾は、補間でframe=1300、14秒後・15秒後は1600→2100付近。
    hits = checks.read_game_hit_times(MOD_LOG, "th06", replay_start_frame=1000)
    # lives 2→1 は 10:00:14 = frame 1600 + (2600-1600)*(1/3) ≈ 1933、1→0 は ≈ 2267
    assert hits == [round((1600 + 1000 / 3 - 1000) / 60, 1), round((1600 + 2000 / 3 - 1000) / 60, 1)]


def test_read_game_hit_times_ignores_samples_before_replay_start():
    assert checks.read_game_hit_times(MOD_LOG, "th06", replay_start_frame=None) == []
    # 再生開始がずっと後なら、被弾は数えない(開始前のlivesで基準だけ更新される)。
    assert checks.read_game_hit_times(MOD_LOG, "th06", replay_start_frame=10_000) == []


def test_read_final_state_uses_last_sample_with_expected_score():
    assert checks.read_final_state(MOD_LOG, "th06", 300) == (7, 0, 12)
    assert checks.read_final_state(MOD_LOG, "th06", 999) is None
    assert checks.read_final_state(MOD_LOG, "th06", None) is None
    # th07系は内部値が表示値の1/10。
    assert checks.read_final_state(MOD_LOG, "th07", 3000) == (7, 0, 12)


def test_check_mod_log_ok_and_violations():
    assert checks.check_mod_log(MOD_LOG) == []
    bad = MOD_LOG.replace("refill_timeouts=0 unknown_plays=0", "refill_timeouts=2 unknown_plays=1")
    problems = checks.check_mod_log(bad)
    assert len(problems) == 2
    mismatch = MOD_LOG.replace("frames_mixed=3000", "frames_mixed=2999")
    assert any("食い違う" in p for p in checks.check_mod_log(mismatch))
    err = MOD_LOG + "[10:00:18.000] FrameSyncSleepMs: TIMEOUT waiting 5 frames (ms=100)\n"
    assert any("異常行" in p for p in checks.check_mod_log(err))
    assert len(checks.check_mod_log("")) == 2


def test_check_mod_log_present_count_off_by_one():
    bad = MOD_LOG.replace("present_count=3001", "present_count=3005")
    assert any("Present回数" in p for p in checks.check_mod_log(bad))


def test_check_frame_counts():
    ok = "[FRAME_SYNC] MODが書いたフレーム数=8223 動画のフレーム数=8223 音声のフレーム数=8223(PCMの端数0バイト) 一致=OK"
    assert checks.check_frame_counts(ok) == []
    ng = ok.replace("音声のフレーム数=8223", "音声のフレーム数=8222").replace("一致=OK", "一致=NG")
    assert checks.check_frame_counts(ng)
    assert checks.check_frame_counts("")


def test_check_play_duration():
    log = "[FRAME_SYNC] 理論尺との比較: 再生区間119.2秒 / 理論115.4秒 = +3.28%"
    assert checks.check_play_duration(log, 119.0) == []
    assert checks.check_play_duration(log, 110.0)
    assert checks.check_play_duration("", 110.0)
    assert checks.check_play_duration(log, None) == []


def test_check_final_state_and_hit_times():
    assert checks.check_final_state((7, 0, 12), (7, 0, 12)) == []
    assert checks.check_final_state((7, 0, 13), (7, 0, 12))
    assert checks.check_final_state(None, (7, 0, 12))
    assert checks.check_final_state(None, None) == []
    assert checks.check_hit_times([84.1, 121.1], [84.0, 121.5]) == []
    assert checks.check_hit_times([84.1], [84.0, 121.5])  # 回数違い
    assert checks.check_hit_times([84.1, 125.0], [84.0, 121.5])  # ずれ過ぎ
    assert checks.check_hit_times([], [84.0])
    assert checks.check_hit_times([1.0], None) == []


def test_check_video_info():
    info = {
        "video": {"width": 640, "height": 480, "r_frame_rate": "60/1", "duration": 137.05, "nb_frames": 8223},
        "audio": {"duration": 137.05},
    }
    assert checks.check_video_info(info, (640, 480), 8223) == []
    bad = {**info, "video": {**info["video"], "width": 1280, "r_frame_rate": "30/1", "nb_frames": 8000}}
    assert len(checks.check_video_info(bad, (640, 480), 8223)) == 3
    assert any("長さ" in p for p in checks.check_video_info({**info, "audio": {"duration": 130.0}}, (640, 480), 8223))
    assert any("音声ストリーム" in p for p in checks.check_video_info({"video": info["video"]}, (640, 480), 8223))
    assert checks.check_video_info({}, (640, 480), 1)


def test_check_audible_and_blank_frames():
    assert checks.check_audible(-5.0) == []
    assert checks.check_audible(-90.0)
    assert checks.check_audible(None)
    assert checks.check_frames_not_blank([30.0, 40.0, 25.0]) == []
    assert checks.check_frames_not_blank([30.0, 0.5])
    assert checks.check_frames_not_blank([])


def test_check_mod_log_allows_title_specific_refill_timeouts():
    log = MOD_LOG.replace("refill_timeouts=0", "refill_timeouts=2")
    assert checks.check_mod_log(log, max_refill_timeouts=20) == []
    assert checks.check_mod_log(log)
