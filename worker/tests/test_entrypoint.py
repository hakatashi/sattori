"""`entrypoint.py` の出力構成の決定と、チェックポイントの倍率保持のテスト。

`entrypoint.py` はモジュール読み込み時に環境変数を参照するため、import 前に
必要な環境変数を差し込む。ffmpeg/S3/DynamoDB は差し替えて実際には触らない。
"""
import importlib
import sys

import pytest

REQUIRED_ENV = {
    "JOB_ID": "job-1",
    "GAME": "th20",
    "REPLAY_BUCKET": "replay-bucket",
    "REPLAY_KEY": "replays/abc.rpy",
    "OUTPUT_BUCKET": "output-bucket",
    "TITLE_ASSETS_BUCKET": "title-assets",
}


class FakeS3:
    """このテストで使う範囲だけの S3 スタブ。"""

    def __init__(self, metadata=None, head_error=None):
        self.uploads = []
        self.deleted = []
        self._metadata = metadata
        self._head_error = head_error

    def upload_file(self, path, bucket, key, ExtraArgs=None):  # noqa: N803 - boto3のAPI名
        self.uploads.append({"path": path, "key": key, "extra": ExtraArgs or {}})

    def delete_object(self, Bucket, Key):  # noqa: N803 - boto3のAPI名
        self.deleted.append(Key)

    def head_object(self, Bucket, Key):  # noqa: N803 - boto3のAPI名
        if self._head_error is not None:
            raise self._head_error
        return {"Metadata": self._metadata or {}}


@pytest.fixture
def entrypoint(monkeypatch, tmp_path):
    for key, value in REQUIRED_ENV.items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv("FPS_LIMIT_TARGET_HZ", raising=False)
    monkeypatch.delenv("JOBS_TABLE", raising=False)
    sys.modules.pop("entrypoint", None)
    module = importlib.import_module("entrypoint")

    # 本番の作業ディレクトリは`/app`固定なので、テストでは書ける場所へ差し替える。
    # 実ffmpeg・実S3・実DynamoDBにも触らせない。
    for name in ("OUTPUT_VIDEO", "OUTPUT_VIDEO_DELIVERY"):
        path = str(tmp_path / f"{name.lower()}.mp4")
        with open(path, "wb") as f:
            f.write(b"x" * 10)
        monkeypatch.setattr(module, name, path)
    monkeypatch.setattr(module, "update_status", lambda *a, **k: recorded_status.append((a, k)))
    monkeypatch.setattr(module, "update_progress", lambda *a, **k: None)
    monkeypatch.setattr(module, "upload_ffmpeg_upscale_log_if_present", lambda s3: None)
    monkeypatch.setattr(module, "convert_for_delivery", lambda *a, **k: None)
    recorded_status = []
    module._recorded_status = recorded_status
    yield module
    sys.modules.pop("entrypoint", None)


def status_kwargs(module, status):
    for args, kwargs in module._recorded_status:
        if args[1] == status:
            return kwargs
    raise AssertionError(f"{status} への更新が行われていません")


# --- 出力が2本になる場合(th06/07/08/11の等倍録画) --------------------------


def test_keeps_both_outputs_when_the_resolution_changes(entrypoint, monkeypatch):
    monkeypatch.setattr(entrypoint, "probe_resolution", lambda path: (640, 480))
    s3 = FakeS3()

    entrypoint.convert_and_upload(s3, 1.0)

    kwargs = status_kwargs(entrypoint, "done")
    assert kwargs["output_path"] == entrypoint.OUTPUT_KEY
    assert kwargs["output_path_720p"] == entrypoint.OUTPUT_KEY_DELIVERY
    # 生データはそのまま元解像度版として配信するので消さない。
    assert s3.deleted == []


# --- 出力が1本になる場合(th20・低速録画) ----------------------------------


def test_collapses_to_one_output_when_the_resolution_does_not_change(entrypoint, monkeypatch):
    monkeypatch.setattr(entrypoint, "probe_resolution", lambda path: (1280, 960))
    s3 = FakeS3()

    entrypoint.convert_and_upload(s3, 1.0)

    kwargs = status_kwargs(entrypoint, "done")
    # `outputPath` が変換結果を指し、720p版は作られない(null のまま)。
    assert kwargs["output_path"] == entrypoint.OUTPUT_KEY_DELIVERY
    assert "output_path_720p" not in kwargs


def test_deletes_the_raw_checkpoint_when_it_is_no_longer_served(entrypoint, monkeypatch):
    # 消さないとジョブあたりのS3保管量が倍のまま残る(AGENTS.md §6)。
    monkeypatch.setattr(entrypoint, "probe_resolution", lambda path: (1280, 960))
    s3 = FakeS3()

    entrypoint.convert_and_upload(s3, 2.0)

    assert s3.deleted == [entrypoint.OUTPUT_KEY]


def test_marks_done_before_deleting_the_raw_checkpoint(entrypoint, monkeypatch):
    """順序が逆だと、削除後・status更新前に落ちたジョブが復旧不能になる。"""
    monkeypatch.setattr(entrypoint, "probe_resolution", lambda path: (1280, 960))
    order = []
    monkeypatch.setattr(
        entrypoint, "update_status", lambda *a, **k: order.append(f"status:{a[1]}")
    )

    class OrderedS3(FakeS3):
        def delete_object(self, Bucket, Key):  # noqa: N803
            order.append("delete")
            super().delete_object(Bucket=Bucket, Key=Key)

    entrypoint.convert_and_upload(OrderedS3(), 2.0)

    assert order.index("status:done") < order.index("delete")


def test_a_failed_delete_does_not_fail_the_finished_job(entrypoint, monkeypatch):
    monkeypatch.setattr(entrypoint, "probe_resolution", lambda path: (1280, 960))

    class ExplodingS3(FakeS3):
        def delete_object(self, Bucket, Key):  # noqa: N803
            raise RuntimeError("AccessDenied")

    # 例外を投げない(残ってもライフサイクルルールでいずれ消える)。
    entrypoint.convert_and_upload(ExplodingS3(), 2.0)

    assert status_kwargs(entrypoint, "done")["output_path"] == entrypoint.OUTPUT_KEY_DELIVERY


# --- チェックポイントに添える実時間スケール -------------------------------


def test_reads_the_time_scale_recorded_with_the_raw_checkpoint(entrypoint):
    """**環境変数から取り直してはいけない**。

    自宅ワーカーが低速録画した後にリトライがEC2へ回ると、EC2側には
    `FPS_LIMIT_TARGET_HZ` が渡らない(低速録画は自宅限定なので渡さないのが正しい)。
    倍率を生データ自身に添えておかないと、半分の速度の動画をそのまま配信してしまう。
    """
    s3 = FakeS3(metadata={entrypoint.TIME_SCALE_METADATA_KEY: "2.0"})

    assert entrypoint.read_checkpoint_time_scale(s3) == 2.0


def test_falls_back_to_normal_speed_when_the_metadata_is_missing(entrypoint):
    # このフィールド導入前のジョブ。
    assert entrypoint.read_checkpoint_time_scale(FakeS3(metadata={})) == 1.0


def test_falls_back_to_normal_speed_when_the_head_request_fails(entrypoint):
    # ここで例外にすると、変換から再開できたはずのジョブを録画からやり直させることになる。
    s3 = FakeS3(head_error=RuntimeError("throttled"))

    assert entrypoint.read_checkpoint_time_scale(s3) == 1.0


def test_upload_video_attaches_metadata_when_given(entrypoint):
    s3 = FakeS3()

    entrypoint.upload_video(
        s3, entrypoint.OUTPUT_VIDEO, "videos/job-1.mp4", metadata={"sattori-time-scale": "2.0"},
    )

    assert s3.uploads[0]["extra"]["Metadata"] == {"sattori-time-scale": "2.0"}
    assert s3.uploads[0]["extra"]["ContentType"] == "video/mp4"
