import io
import os
import tarfile
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
