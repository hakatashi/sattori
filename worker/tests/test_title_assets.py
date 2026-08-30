import io
import os
import tarfile
import time
from unittest.mock import MagicMock

import title_assets as ta


def make_archive(dest_path, files):
    """files: {相対パス: バイト列} からS3が返す想定のtar.gzを作る。"""
    with tarfile.open(dest_path, "w:gz") as tar:
        for rel_path, content in files.items():
            info = tarfile.TarInfo(name=rel_path)
            info.size = len(content)
            tar.addfile(info, io.BytesIO(content))
    return dest_path


def fake_download(archive_path):
    def _download_file(bucket, key, dest):
        with open(archive_path, "rb") as src, open(dest, "wb") as dst:
            dst.write(src.read())

    return _download_file


def test_skips_download_when_already_extracted(tmp_path, monkeypatch):
    monkeypatch.setattr(ta, "REPO", str(tmp_path))
    (tmp_path / "games" / "th07").mkdir(parents=True)
    s3 = MagicMock()

    ta.ensure_title_assets(s3, "assets-bucket", "th07")

    s3.download_file.assert_not_called()


def test_downloads_and_extracts_when_missing(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    repo.mkdir()
    download_dir = tmp_path / "downloads"
    download_dir.mkdir()
    monkeypatch.setattr(ta, "REPO", str(repo))
    monkeypatch.setattr(ta, "DOWNLOAD_DIR", str(download_dir))

    archive_path = make_archive(
        tmp_path / "src.tar.gz",
        {
            "games/th07/th07.exe": b"game-body",
            "prefixes/th07-wined3d-gl/marker": b"prefix",
            "mods/common/build/injector.exe": b"injector",
            "mods/th07_replay_autoplay/build/th07_hook.dll": b"hook",
        },
    )
    s3 = MagicMock()
    s3.download_file.side_effect = fake_download(archive_path)

    ta.ensure_title_assets(s3, "assets-bucket", "th07")

    s3.download_file.assert_called_once_with(
        "assets-bucket", "titles/th07/assets.tar.gz", str(download_dir / "sattori-title-assets-th07.tar.gz")
    )
    assert (repo / "games" / "th07" / "th07.exe").read_bytes() == b"game-body"
    assert (repo / "prefixes" / "th07-wined3d-gl" / "marker").read_bytes() == b"prefix"
    assert (repo / "mods" / "common" / "build" / "injector.exe").read_bytes() == b"injector"
    assert (repo / "mods" / "th07_replay_autoplay" / "build" / "th07_hook.dll").read_bytes() == b"hook"
    # ダウンロードした一時アーカイブはクリーンアップされる
    assert not (download_dir / "sattori-title-assets-th07.tar.gz").exists()


def test_extracts_wineprefix_absolute_symlinks(tmp_path, monkeypatch):
    """WINEPREFIXの`dosdevices/z:`->`/`のような絶対パスへのシンボリックリンクは
    Wineのドライブマッピングとして正常な構造であり、展開できなければならない
    (Python 3.12+の既定filter="data"は絶対リンクを一律拒否するため、
    filter="fully_trusted"を使う必要がある。実際にth08で展開失敗した障害の回帰テスト)。
    """
    repo = tmp_path / "repo"
    repo.mkdir()
    download_dir = tmp_path / "downloads"
    download_dir.mkdir()
    monkeypatch.setattr(ta, "REPO", str(repo))
    monkeypatch.setattr(ta, "DOWNLOAD_DIR", str(download_dir))

    archive_path = tmp_path / "src.tar.gz"
    with tarfile.open(archive_path, "w:gz") as tar:
        game_info = tarfile.TarInfo(name="games/th08/th08.exe")
        game_info.size = len(b"game-body")
        tar.addfile(game_info, io.BytesIO(b"game-body"))

        link_info = tarfile.TarInfo(name="prefixes/th08-wined3d-gl/dosdevices/z:")
        link_info.type = tarfile.SYMTYPE
        link_info.linkname = "/"
        tar.addfile(link_info)

    s3 = MagicMock()
    s3.download_file.side_effect = fake_download(archive_path)

    ta.ensure_title_assets(s3, "assets-bucket", "th08")

    link_path = repo / "prefixes" / "th08-wined3d-gl" / "dosdevices" / "z:"
    assert link_path.is_symlink()
    assert os.readlink(link_path) == "/"


def test_removes_archive_even_when_extraction_fails(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    repo.mkdir()
    download_dir = tmp_path / "downloads"
    download_dir.mkdir()
    monkeypatch.setattr(ta, "REPO", str(repo))
    monkeypatch.setattr(ta, "DOWNLOAD_DIR", str(download_dir))

    broken_archive = download_dir / "broken.tar.gz"
    broken_archive.write_bytes(b"not-a-real-tar-gz")
    s3 = MagicMock()
    s3.download_file.side_effect = fake_download(broken_archive)

    try:
        ta.ensure_title_assets(s3, "assets-bucket", "th07")
    except Exception:
        pass

    assert not (download_dir / "sattori-title-assets-th07.tar.gz").exists()


def make_s3_with_archive(archive_path, *, etag="abc123", head_error=None):
    s3 = MagicMock()
    s3.download_file.side_effect = fake_download(archive_path)
    if head_error is not None:
        s3.head_object.side_effect = head_error
    else:
        s3.head_object.return_value = {"ETag": f'"{etag}"'}
    return s3


class TestTitleAssetsCache:
    """`TITLE_ASSETS_CACHE_DIR`(自宅ワーカー向け、Issue #104)経由のキャッシュ挙動。"""

    def _prepare(self, tmp_path, monkeypatch):
        repo = tmp_path / "repo"
        repo.mkdir()
        download_dir = tmp_path / "downloads"
        download_dir.mkdir()
        cache_dir = tmp_path / "cache"
        monkeypatch.setattr(ta, "REPO", str(repo))
        monkeypatch.setattr(ta, "DOWNLOAD_DIR", str(download_dir))
        return repo, download_dir, cache_dir

    def test_downloads_once_and_links_into_repo(self, tmp_path, monkeypatch):
        repo, download_dir, cache_dir = self._prepare(tmp_path, monkeypatch)
        archive_path = make_archive(
            tmp_path / "src.tar.gz",
            {
                "games/th07/th07.exe": b"game-body",
                "prefixes/th07-wined3d-gl/marker": b"prefix",
                "mods/common/build/injector.exe": b"injector",
                "mods/th07_replay_autoplay/build/th07_hook.dll": b"hook",
            },
        )
        s3 = make_s3_with_archive(archive_path)
        env = {"TITLE_ASSETS_CACHE_DIR": str(cache_dir)}

        ta.ensure_title_assets(s3, "assets-bucket", "th07", env=env)

        assert s3.download_file.call_count == 1
        assert (repo / "games" / "th07" / "th07.exe").read_bytes() == b"game-body"
        assert (repo / "games" / "th07").is_symlink()
        assert (
            cache_dir / "th07" / "v-abc123" / "games" / "th07" / "th07.exe"
        ).read_bytes() == b"game-body"

    def test_second_job_reuses_cache_without_downloading(self, tmp_path, monkeypatch):
        _repo1, download_dir, cache_dir = self._prepare(tmp_path, monkeypatch)
        archive_path = make_archive(
            tmp_path / "src.tar.gz", {"games/th07/th07.exe": b"game-body"},
        )
        s3 = make_s3_with_archive(archive_path)
        env = {"TITLE_ASSETS_CACHE_DIR": str(cache_dir)}
        ta.ensure_title_assets(s3, "assets-bucket", "th07", env=env)

        # 2本目のジョブは別コンテナ(=別のREPO)から同じキャッシュを見る想定。
        repo2 = tmp_path / "repo2"
        repo2.mkdir()
        monkeypatch.setattr(ta, "REPO", str(repo2))
        s3.download_file.reset_mock()

        ta.ensure_title_assets(s3, "assets-bucket", "th07", env=env)

        s3.download_file.assert_not_called()
        assert (repo2 / "games" / "th07" / "th07.exe").read_bytes() == b"game-body"

    def test_etag_change_invalidates_cache(self, tmp_path, monkeypatch):
        repo, download_dir, cache_dir = self._prepare(tmp_path, monkeypatch)
        archive_v1 = make_archive(
            tmp_path / "v1.tar.gz", {"games/th07/th07.exe": b"old-body"},
        )
        s3 = make_s3_with_archive(archive_v1, etag="v1")
        env = {"TITLE_ASSETS_CACHE_DIR": str(cache_dir)}
        ta.ensure_title_assets(s3, "assets-bucket", "th07", env=env)
        assert (repo / "games" / "th07" / "th07.exe").read_bytes() == b"old-body"

        # リモートのアーカイブが更新された(ETagが変わった)想定。
        repo2 = tmp_path / "repo2"
        repo2.mkdir()
        monkeypatch.setattr(ta, "REPO", str(repo2))
        archive_v2 = make_archive(
            tmp_path / "v2.tar.gz", {"games/th07/th07.exe": b"new-body"},
        )
        s3.download_file.side_effect = fake_download(archive_v2)
        s3.head_object.return_value = {"ETag": '"v2"'}
        s3.download_file.reset_mock()

        ta.ensure_title_assets(s3, "assets-bucket", "th07", env=env)

        assert s3.download_file.call_count == 1
        assert (repo2 / "games" / "th07" / "th07.exe").read_bytes() == b"new-body"
        # 古い世代はまだ残っている(即時削除しない。猶予期間経過後にのみ掃除する)。
        assert (cache_dir / "th07" / "v-v1").exists()

    def test_head_object_failure_falls_back_to_existing_cache(self, tmp_path, monkeypatch):
        repo, download_dir, cache_dir = self._prepare(tmp_path, monkeypatch)
        archive_path = make_archive(
            tmp_path / "src.tar.gz", {"games/th07/th07.exe": b"game-body"},
        )
        s3 = make_s3_with_archive(archive_path, etag="v1")
        env = {"TITLE_ASSETS_CACHE_DIR": str(cache_dir)}
        ta.ensure_title_assets(s3, "assets-bucket", "th07", env=env)

        repo2 = tmp_path / "repo2"
        repo2.mkdir()
        monkeypatch.setattr(ta, "REPO", str(repo2))
        s3.head_object.side_effect = ConnectionError("network down")

        ta.ensure_title_assets(s3, "assets-bucket", "th07", env=env)

        assert (repo2 / "games" / "th07" / "th07.exe").read_bytes() == b"game-body"

    def test_head_object_failure_without_cache_raises(self, tmp_path, monkeypatch):
        _repo, _download_dir, cache_dir = self._prepare(tmp_path, monkeypatch)
        s3 = MagicMock()
        s3.head_object.side_effect = ConnectionError("network down")
        env = {"TITLE_ASSETS_CACHE_DIR": str(cache_dir)}

        try:
            ta.ensure_title_assets(s3, "assets-bucket", "th07", env=env)
            assert False, "例外が発生するはず"
        except ConnectionError:
            pass

    def test_stale_version_is_cleaned_up_after_grace_period(self, tmp_path, monkeypatch):
        repo, download_dir, cache_dir = self._prepare(tmp_path, monkeypatch)
        archive_v1 = make_archive(
            tmp_path / "v1.tar.gz", {"games/th07/th07.exe": b"old-body"},
        )
        s3 = make_s3_with_archive(archive_v1, etag="v1")
        env = {"TITLE_ASSETS_CACHE_DIR": str(cache_dir)}
        ta.ensure_title_assets(s3, "assets-bucket", "th07", env=env)

        old_version_dir = cache_dir / "th07" / "v-v1"
        old_time = time.time() - ta.STALE_VERSION_MAX_AGE_SECONDS - 60
        os.utime(old_version_dir, (old_time, old_time))

        repo2 = tmp_path / "repo2"
        repo2.mkdir()
        monkeypatch.setattr(ta, "REPO", str(repo2))
        archive_v2 = make_archive(
            tmp_path / "v2.tar.gz", {"games/th07/th07.exe": b"new-body"},
        )
        s3.download_file.side_effect = fake_download(archive_v2)
        s3.head_object.return_value = {"ETag": '"v2"'}

        ta.ensure_title_assets(s3, "assets-bucket", "th07", env=env)

        assert not old_version_dir.exists()
