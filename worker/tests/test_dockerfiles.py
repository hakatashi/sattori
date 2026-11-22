"""ワーカーイメージ(CPU・GPU)にフレーム同期の経路が入ること(Issue #389)。

th10で、新しいモジュールを両方のDockerfileのCOPYへ足し忘れた前例がある。フレーム同期の
モジュールは`recording/`の中にあり、そのディレクトリごとCOPYされるので、両方のDockerfileが
`recording/`をCOPYしていること・個別に除外していないことを確かめる。
"""
from pathlib import Path

import pytest

WORKER = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("name", ["Dockerfile", "Dockerfile.gpu"])
def test_dockerfile_copies_the_recording_package(name):
    lines = (WORKER / name).read_text().splitlines()
    assert "COPY recording/ /app/recording/" in lines
    assert (WORKER / "recording" / "framesync.py").exists()


def test_dockerignore_does_not_exclude_the_recording_package():
    path = WORKER / ".dockerignore"
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        assert not line.startswith("recording"), line
        assert "framesync" not in line, line
