from unittest.mock import MagicMock

import pytest

import status


@pytest.fixture(autouse=True)
def reset_dynamodb_cache():
    # _table() が boto3.resource() の戻り値をモジュールグローバルにキャッシュするため、
    # テスト間でモックが漏れないようにテスト毎にリセットする。
    status._dynamodb = None
    yield
    status._dynamodb = None


def mock_dynamodb_resource(monkeypatch):
    mock_resource = MagicMock()
    monkeypatch.setattr(status.boto3, "resource", MagicMock(return_value=mock_resource))
    return mock_resource


def test_get_job_skips_without_table(monkeypatch):
    monkeypatch.delenv("JOBS_TABLE", raising=False)
    mock_resource = mock_dynamodb_resource(monkeypatch)

    assert status.get_job("job-1") is None
    mock_resource.Table.assert_not_called()


def test_get_job_returns_item(monkeypatch):
    monkeypatch.setenv("JOBS_TABLE", "jobs-table")
    mock_resource = mock_dynamodb_resource(monkeypatch)
    mock_table = mock_resource.Table.return_value
    mock_table.get_item.return_value = {"Item": {"jobId": "job-1", "status": "done"}}

    result = status.get_job("job-1")

    mock_resource.Table.assert_called_once_with("jobs-table")
    mock_table.get_item.assert_called_once_with(Key={"jobId": "job-1"})
    assert result == {"jobId": "job-1", "status": "done"}


def test_get_job_returns_none_when_item_missing(monkeypatch):
    monkeypatch.setenv("JOBS_TABLE", "jobs-table")
    mock_resource = mock_dynamodb_resource(monkeypatch)
    mock_resource.Table.return_value.get_item.return_value = {}

    assert status.get_job("job-1") is None


def test_update_status_skips_without_table(monkeypatch):
    monkeypatch.delenv("JOBS_TABLE", raising=False)
    mock_resource = mock_dynamodb_resource(monkeypatch)

    status.update_status("job-1", "recording")

    mock_resource.Table.assert_not_called()


def test_update_status_builds_minimal_update(monkeypatch):
    monkeypatch.setenv("JOBS_TABLE", "jobs-table")
    mock_resource = mock_dynamodb_resource(monkeypatch)
    mock_table = mock_resource.Table.return_value

    status.update_status("job-1", "recording")

    _, kwargs = mock_table.update_item.call_args
    assert kwargs["Key"] == {"jobId": "job-1"}
    assert kwargs["UpdateExpression"] == "SET #s = :s, updatedAt = :u"
    assert kwargs["ExpressionAttributeNames"] == {"#s": "status"}
    assert kwargs["ExpressionAttributeValues"][":s"] == "recording"


def test_update_status_includes_optional_fields(monkeypatch):
    monkeypatch.setenv("JOBS_TABLE", "jobs-table")
    mock_resource = mock_dynamodb_resource(monkeypatch)
    mock_table = mock_resource.Table.return_value

    status.update_status(
        "job-1",
        "failed",
        output_path="videos/job-1.mp4",
        output_path_720p="videos/job-1_720p.mp4",
        error="録画処理中にエラーが発生しました",
    )

    _, kwargs = mock_table.update_item.call_args
    assert kwargs["ExpressionAttributeValues"][":o"] == "videos/job-1.mp4"
    assert kwargs["ExpressionAttributeValues"][":o720"] == "videos/job-1_720p.mp4"
    assert kwargs["ExpressionAttributeValues"][":e"] == "録画処理中にエラーが発生しました"
    assert kwargs["ExpressionAttributeNames"]["#e"] == "error"
    assert "outputPath = :o" in kwargs["UpdateExpression"]
    assert "outputPath720p = :o720" in kwargs["UpdateExpression"]
    assert "#e = :e" in kwargs["UpdateExpression"]


def test_update_progress_skips_without_table(monkeypatch):
    monkeypatch.delenv("JOBS_TABLE", raising=False)
    mock_resource = mock_dynamodb_resource(monkeypatch)

    status.update_progress("job-1", 50)

    mock_resource.Table.assert_not_called()


def test_update_progress_without_preview_image(monkeypatch):
    monkeypatch.setenv("JOBS_TABLE", "jobs-table")
    mock_resource = mock_dynamodb_resource(monkeypatch)
    mock_table = mock_resource.Table.return_value

    status.update_progress("job-1", 30)

    _, kwargs = mock_table.update_item.call_args
    assert kwargs["ExpressionAttributeValues"][":p"] == 30
    assert ":pi" not in kwargs["ExpressionAttributeValues"]


def test_update_progress_with_preview_image(monkeypatch):
    monkeypatch.setenv("JOBS_TABLE", "jobs-table")
    mock_resource = mock_dynamodb_resource(monkeypatch)
    mock_table = mock_resource.Table.return_value

    status.update_progress("job-1", 42, preview_image_path="progress/job-1/1.jpg")

    _, kwargs = mock_table.update_item.call_args
    assert kwargs["ExpressionAttributeValues"][":p"] == 42
    assert kwargs["ExpressionAttributeValues"][":pi"] == "progress/job-1/1.jpg"
    assert "previewImagePath = :pi" in kwargs["UpdateExpression"]
