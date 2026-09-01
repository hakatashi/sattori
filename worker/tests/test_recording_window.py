"""ウィンドウ検出とクロップ座標の確定。"""

from recording import window
from recording_helpers import make_config


class _FakeCompleted:
    def __init__(self, stdout=""):
        self.stdout = stdout


def _fake_run_factory(commands, window_ids=("12345",)):
    """xdotool search/windowmap・xwininfoの呼び出しを記録しつつ、常にviewableな
    640x480ウィンドウが1つ見つかったことにするsubprocess.runの差し替え。"""

    def fake_run(cmd, **kwargs):
        commands.append(list(cmd))
        if cmd[:2] == ["xdotool", "search"]:
            return _FakeCompleted(stdout=" ".join(window_ids) + "\n")
        if cmd[:2] == ["xdotool", "windowmap"]:
            return _FakeCompleted()
        if cmd[:1] == ["xwininfo"]:
            return _FakeCompleted(stdout=(
                "IsViewable\n"
                "  Absolute upper-left X:  10\n"
                "  Absolute upper-left Y:  20\n"
                "  Width: 640\n"
                "  Height: 480\n"
            ))
        raise AssertionError(f"unexpected command: {cmd!r}")

    return fake_run


def test_find_window_maps_all_detected_windows_when_force_window_map_is_set(monkeypatch):
    """th12のように最小化(Iconic)状態で生成されるゲーム向けの対策(reports/61)。

    force_window_map=Trueのとき、xdotool searchで見つけた各ウィンドウにwindowmapを
    発行してから、既存のIsViewable判定ループに入ること。"""
    commands = []
    monkeypatch.setattr(window.subprocess, "run", _fake_run_factory(commands))
    config = make_config(force_window_map=True)

    geom = window.find_window(config, {}, 123)

    assert geom == (10, 20, 640, 480, "12345")
    assert ["xdotool", "windowmap", "12345"] in commands


def test_find_window_does_not_map_windows_by_default(monkeypatch):
    """既定(force_window_map=False)の他タイトルには副作用が無いこと(回帰防止)。"""
    commands = []
    monkeypatch.setattr(window.subprocess, "run", _fake_run_factory(commands))
    config = make_config()

    geom = window.find_window(config, {}, 123)

    assert geom == (10, 20, 640, 480, "12345")
    assert not any(cmd[:2] == ["xdotool", "windowmap"] for cmd in commands)


def test_wait_for_stable_geometry_waits_until_two_reads_agree(monkeypatch):
    """ゲームが初期化中に自分でウィンドウを再配置する間(th11)は座標を確定しない。

    th11の実測値(openboxの初期配置(159,119)→移動中の破れた値→安定位置(185,211))を
    再現し、安定位置だけが返ることを確認する。"""
    reads = [
        (159, 119, 640, 480, "w1"),
        (197, 196, 640, 480, "w1"),
        (185, 211, 640, 480, "w1"),
        (185, 211, 640, 480, "w1"),
        (999, 999, 640, 480, "w1"),  # ここまで到達しないはず
    ]
    monkeypatch.setattr(window, "find_window", lambda *a, **k: reads.pop(0))

    geom = window.wait_for_stable_geometry(
        make_config(), {}, 123, log=lambda m: None, settle_sec=0, timeout=5
    )

    assert geom == (185, 211, 640, 480, "w1")
    assert len(reads) == 1


def test_wait_for_stable_geometry_returns_last_read_and_warns_on_timeout(monkeypatch):
    """安定しないまま時間切れになった場合は最後の取得値を警告付きで返す。"""
    counter = {"n": 0}

    def never_stable(*a, **k):
        counter["n"] += 1
        return (counter["n"], counter["n"], 640, 480, "w1")

    monkeypatch.setattr(window, "find_window", never_stable)
    logs = []

    geom = window.wait_for_stable_geometry(
        make_config(), {}, 123, log=logs.append, settle_sec=0, timeout=0.05
    )

    assert geom == (counter["n"], counter["n"], 640, 480, "w1")
    assert any("安定しませんでした" in m for m in logs)


def test_wait_for_stable_geometry_returns_none_when_window_never_found(monkeypatch):
    monkeypatch.setattr(window, "find_window", lambda *a, **k: None)
    logs = []

    geom = window.wait_for_stable_geometry(
        make_config(), {}, 123, log=logs.append, settle_sec=0, timeout=0.05
    )

    assert geom is None
