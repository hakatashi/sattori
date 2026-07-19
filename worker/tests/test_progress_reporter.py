import json
from unittest.mock import MagicMock

import progress_reporter as pr


def write_progress_files(progress_dir, elapsed=None, expected=None):
    (progress_dir / "frame.jpg").write_bytes(b"fake-jpeg")
    state = {}
    if elapsed is not None:
        state["elapsedSeconds"] = elapsed
    if expected is not None:
        state["expectedDurationSeconds"] = expected
    (progress_dir / "state.json").write_text(json.dumps(state))


def make_reporter(tmp_path, monkeypatch, s3=None, log=None):
    update_progress_mock = MagicMock()
    monkeypatch.setattr(pr, "update_progress", update_progress_mock)
    s3 = s3 or MagicMock()
    reporter = pr.ProgressReporter(
        s3, "output-bucket", "job-1", str(tmp_path), log=log or (lambda msg: None)
    )
    return reporter, s3, update_progress_mock


def test_tick_skips_when_files_missing(tmp_path, monkeypatch):
    reporter, s3, update_progress_mock = make_reporter(tmp_path, monkeypatch)

    reporter._tick()

    s3.upload_file.assert_not_called()
    update_progress_mock.assert_not_called()


def test_tick_uploads_frame_and_reports_progress(tmp_path, monkeypatch):
    write_progress_files(tmp_path, elapsed=30, expected=60)
    reporter, s3, update_progress_mock = make_reporter(tmp_path, monkeypatch)

    reporter._tick()

    s3.upload_file.assert_called_once()
    args, kwargs = s3.upload_file.call_args
    assert args[0] == str(tmp_path / "frame.jpg")
    assert args[1] == "output-bucket"
    assert args[2].startswith("progress/job-1/")
    assert args[2].endswith(".jpg")
    assert kwargs["ExtraArgs"] == {"ContentType": "image/jpeg"}

    update_progress_mock.assert_called_once_with("job-1", 50, preview_image_path=args[2])


def test_tick_caps_progress_at_99_percent(tmp_path, monkeypatch):
    write_progress_files(tmp_path, elapsed=60, expected=60)
    reporter, s3, update_progress_mock = make_reporter(tmp_path, monkeypatch)

    reporter._tick()

    percent = update_progress_mock.call_args[0][1]
    assert percent == 99


def test_tick_passes_none_percent_when_expected_missing(tmp_path, monkeypatch):
    write_progress_files(tmp_path, elapsed=30, expected=None)
    reporter, s3, update_progress_mock = make_reporter(tmp_path, monkeypatch)

    reporter._tick()

    assert update_progress_mock.call_args[0][1] is None


def test_tick_skips_duplicate_mtime(tmp_path, monkeypatch):
    write_progress_files(tmp_path, elapsed=10, expected=60)
    reporter, s3, update_progress_mock = make_reporter(tmp_path, monkeypatch)

    reporter._tick()
    reporter._tick()

    assert s3.upload_file.call_count == 1
    assert update_progress_mock.call_count == 1


def test_tick_uses_unique_key_per_snapshot(tmp_path, monkeypatch):
    write_progress_files(tmp_path, elapsed=10, expected=60)
    reporter, s3, update_progress_mock = make_reporter(tmp_path, monkeypatch)
    reporter._tick()
    first_key = s3.upload_file.call_args[0][2]

    # frame.jpg の mtime を進めて2回目のスナップショットとして扱わせる
    # (CloudFrontの長期キャッシュ対策としてキーは毎回ユニークにする設計、progress_reporter.py参照)。
    import os
    import time

    time.sleep(0.01)
    os.utime(tmp_path / "frame.jpg", (time.time() + 1, time.time() + 1))
    reporter._tick()
    second_key = s3.upload_file.call_args[0][2]

    assert first_key != second_key


def test_tick_swallows_exceptions(tmp_path, monkeypatch):
    write_progress_files(tmp_path, elapsed=10, expected=60)
    logs = []
    s3 = MagicMock()
    s3.upload_file.side_effect = RuntimeError("boom")
    reporter, _, _ = make_reporter(tmp_path, monkeypatch, s3=s3, log=logs.append)

    reporter._tick()  # 例外が伝播せず、ログにのみ記録されること

    assert any("進捗レポート失敗" in msg for msg in logs)
