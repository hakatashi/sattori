"""別プロセスへファイル経由で渡す成果物の書き出し。"""

import json

from PIL import Image

from recording import artifacts


def test_save_progress_snapshot_writes_frame_and_state_atomically(tmp_path):
    color = Image.new("RGB", (640, 480), color=(10, 20, 30))

    artifacts.save_progress_snapshot(str(tmp_path), color, elapsed_seconds=12.3, expected_duration_seconds=60)

    assert (tmp_path / "frame.jpg").exists()
    assert not (tmp_path / "frame.jpg.tmp").exists()
    assert not (tmp_path / "state.json.tmp").exists()
    state = json.loads((tmp_path / "state.json").read_text())
    assert state == {"elapsedSeconds": 12.3, "expectedDurationSeconds": 60}


def test_save_diagnostics_snapshot_writes_jpg_named_by_attempt_and_classification(tmp_path):
    color = Image.new("RGB", (640, 480), color=(10, 20, 30))

    artifacts.save_diagnostics_snapshot(str(tmp_path), color, attempt=2, classification="fps_runaway")

    assert (tmp_path / "attempt2-fps_runaway.jpg").exists()
    assert not (tmp_path / "attempt2-fps_runaway.jpg.tmp").exists()


def test_save_diagnostics_snapshot_skips_without_diagnostics_dir():
    # 例外を出さずに何もしないこと(--diagnostics-dir未指定のローカル実行向け)。
    color = Image.new("RGB", (640, 480), color=(10, 20, 30))
    artifacts.save_diagnostics_snapshot(None, color, attempt=1, classification="timeout")


def test_save_diagnostics_snapshot_skips_without_frame(tmp_path):
    # 1回もフレームを取得できないまま試行が破棄された場合(last_color_frame=None)。
    artifacts.save_diagnostics_snapshot(str(tmp_path), None, attempt=1, classification="timeout")

    assert list(tmp_path.iterdir()) == []


def test_write_desync_result_writes_json(tmp_path):
    path = str(tmp_path / "desync_result.json")

    artifacts.write_desync_result(path, True)

    with open(path) as f:
        assert json.load(f) == {"desyncDetected": True}


def test_write_desync_result_skips_without_path():
    # 例外を出さずに何もしないこと(--desync-result-path未指定のローカル実行向け)。
    artifacts.write_desync_result(None, True)


def test_write_timeout_result_writes_json(tmp_path):
    path = str(tmp_path / "timeout_result.json")

    artifacts.write_timeout_result(path, True)

    with open(path) as f:
        assert json.load(f) == {"timedOut": True}


def test_write_timeout_result_skips_without_path():
    # 例外を出さずに何もしないこと(--timeout-result-path未指定のローカル実行向け)。
    artifacts.write_timeout_result(None, True)
