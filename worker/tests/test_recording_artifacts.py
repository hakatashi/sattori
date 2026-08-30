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
