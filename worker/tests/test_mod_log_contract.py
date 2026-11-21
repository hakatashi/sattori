"""MODログの契約(`mods/core/log_contract.h`)をワーカー側の読み取りで確かめる(Issue #393)。

`mods/tests/log_contract_golden.txt` は、MODの書式で整形した行のゴールデン。MOD側の
`mods/tests/test_log_contract.cpp`(`make -C worker/mods test`)が同じ書式で各行を再現できることを、
このテストがワーカーの正規表現・部分一致で各行を読めることを確かめる。どちらかの書式を変えると
片方が落ちる。同期マーカーの系列(`mods/tests/sync_marker_golden.txt`)も同じ考え方。
"""
from pathlib import Path

from recording import modlog, sync_marker

MODS_TESTS = Path(__file__).resolve().parents[1] / "mods" / "tests"
GOLDEN_LINES = (MODS_TESTS / "log_contract_golden.txt").read_text().splitlines()


def _golden(prefix):
    lines = [line for line in GOLDEN_LINES if prefix in line]
    assert len(lines) == 1, prefix
    return lines[0]


def _write_log(tmp_path, lines):
    path = tmp_path / "th12_autoplay.log"
    path.write_text("".join(line + "\n" for line in lines))
    return path


def test_every_golden_line_has_log_line_prefix():
    assert len(GOLDEN_LINES) == 5
    for line in GOLDEN_LINES:
        assert modlog._LOG_LINE_TIME_RE.match(line), line


def test_step_and_sequence_complete_lines():
    step = _golden("Step ")
    assert modlog.MENU_STEP_LOG_RE.search(step)
    assert modlog.SEQUENCE_COMPLETE_LOG in _golden("sequence complete")


def test_window_stable_line_is_what_pipeline_waits_for():
    assert sync_marker.GAME_READY_LOG in _golden("WaitForStableWindow")


def test_score_monitor_line():
    m = modlog.SCORE_MONITOR_RE.search(_golden("ScoreMonitor"))
    assert m
    assert [int(g) for g in m.groups()] == [3122125, 7, 2, 345, 1763700000123]


def test_sync_marker_line(tmp_path):
    marker = sync_marker.parse_marker_log(str(_write_log(tmp_path, [_golden("SYNC_MARKER")])))
    assert marker == dict(epoch=1763700000.123456, play_call_sec=0.000789, rate=88200,
                          samples=131072, amp=256, seed=0x2545F491)


def test_replay_start_is_the_last_step_before_sequence_complete(tmp_path):
    # 行頭のローカル時刻と同期マーカーの epoch から換算する(modlog.find_replay_start_epoch)
    log = _write_log(tmp_path, GOLDEN_LINES)
    start = modlog.find_replay_start_epoch(str(log), reference_epoch=1763700000.0)
    # Step 行は 01:02:03.004、同期マーカーの行は 12:00:01.500 に epoch=1763700000.123456
    expected = 1763700000.123456 - (12 * 3600 + 1.5) + (1 * 3600 + 2 * 60 + 3.004)
    assert abs(start - expected) < 1e-6


def test_read_verified_scores_reads_golden_line(tmp_path):
    log = _write_log(tmp_path, GOLDEN_LINES)
    assert modlog.read_verified_scores(str(log), "th12") == [31221250]


def _read_sync_marker_golden():
    kv = {}
    for line in (MODS_TESTS / "sync_marker_golden.txt").read_text().splitlines():
        if line and not line.startswith("#"):
            key, value = line.split("=", 1)
            kv[key] = value
    return kv


def test_sync_marker_sequence_matches_mod_golden():
    golden = _read_sync_marker_golden()
    seq = sync_marker.marker_sequence(int(golden["samples"]), int(golden["seed"], 16))
    signs = [1 if v > 0 else 0 for v in seq]
    fnv = 1469598103934665603
    for bit in signs:
        fnv = ((fnv ^ bit) * 1099511628211) & 0xFFFFFFFFFFFFFFFF
    assert "".join("+" if s else "-" for s in signs[:64]) == golden["first64"]
    assert sum(signs) == int(golden["positives"])
    assert f"{fnv:016x}" == golden["fnv1a64"]
