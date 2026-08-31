"""ウィンドウ検出とクロップ座標の確定。"""

from recording import window
from recording_helpers import make_config


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
