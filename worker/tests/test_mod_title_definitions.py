"""MODのタイトル定義(`mods/Makefile` の TITLES・`thNN_replay_autoplay/dllmain.cpp` の `TitleSpec`)と、
ワーカー側のタイトル(`record_thNN.py`・`recording/config.py` の `hook_dll_path`)の対応を確かめる(Issue #394)。

ワーカーは `hook_dll_path` を `mods/<id>_replay_autoplay/build/<id>_hook.dll` へ機械的に組み立て、
MODのMakefileも同じパターンでDLLを出力する。タイトルを足したときにどちらかだけ漏れると、本番で
DLLが見つからずに全ジョブが失敗するので、ソースの上で突き合わせる。
"""
import re
from pathlib import Path

import pytest

WORKER_ROOT = Path(__file__).resolve().parents[1]
MODS = WORKER_ROOT / "mods"

# DXライブラリ系(起動の流れが違うので `TitleSpec` を使わず、メニュー操作だけ共有する)
DXLIB_TITLES = {"th06c", "th06nc"}


def _makefile_titles():
    m = re.search(r"^TITLES\s*:=\s*(.+)$", (MODS / "Makefile").read_text(), re.MULTILINE)
    assert m
    return m.group(1).split()


def _worker_titles():
    return {p.stem.removeprefix("record_") for p in WORKER_ROOT.glob("record_th*.py")}


def test_makefile_titles_match_worker_titles():
    assert set(_makefile_titles()) == _worker_titles()


@pytest.mark.parametrize("title", _makefile_titles())
def test_title_has_dllmain_with_matching_name(title):
    source = (MODS / f"{title}_replay_autoplay" / "dllmain.cpp").read_text()
    if title in DXLIB_TITLES:
        # ログ名・完了行のIDが取り違えられていない
        assert f'LogInit(hModule, "{title}_autoplay.log")' in source
        assert f'RunMenuScript("{title}"' in source
    else:
        # ログ名(`<name>_autoplay.log`)と完了行はTitleSpecの name から作られる
        assert f'.name = "{title}",' in source
        assert "DEFINE_TITLE(kSpec)" in source


@pytest.mark.parametrize("title", sorted(set(_makefile_titles()) - DXLIB_TITLES))
def test_title_spec_menu_is_declared(title):
    """メニュー操作は宣言(`kMenu`)で、各Stepに文言か custom がある。"""
    source = (MODS / f"{title}_replay_autoplay" / "dllmain.cpp").read_text()
    menu = re.search(r"const MenuStep kMenu\[\] = \{(.*?)\n\};", source, re.DOTALL)
    assert menu, "kMenu の宣言が見つからない"
    steps = re.findall(r"^    \{", menu.group(1), re.MULTILINE)
    assert len(steps) >= 5
    assert menu.group(1).count(".label =") + menu.group(1).count(".custom =") == len(steps)
