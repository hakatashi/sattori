from unittest.mock import MagicMock

import interruption_watcher as iw


def make_watcher(monkeypatch, checks, on_interruption=None, log=None):
    """checks は _check() の呼び出し順(spot/instance-action → events/.../rebalance の
    ポーリング1周分の呼び出し列)への戻り値リスト。最後の要素を返した時点で
    watcher.stop() を呼び、_run() のループを1周(または検知直後)で終わらせる。"""
    watcher = iw.InterruptionWatcher(on_interruption or MagicMock(), log=log or (lambda msg: None))
    monkeypatch.setattr(iw, "POLL_INTERVAL_SEC", 0)
    monkeypatch.setattr(watcher, "_get_token", lambda: "token")

    state = {"n": 0}

    def fake_check(token, path):
        idx = state["n"]
        state["n"] += 1
        if idx >= len(checks):
            watcher.stop()
            return None
        if idx == len(checks) - 1:
            watcher.stop()
        return checks[idx]

    monkeypatch.setattr(watcher, "_check", fake_check)
    return watcher


def test_spot_interruption_fires_callback(monkeypatch):
    on_interruption = MagicMock()
    watcher = make_watcher(monkeypatch, [{"action": "terminate"}], on_interruption=on_interruption)

    watcher._run()

    on_interruption.assert_called_once_with("spot_interruption", {"action": "terminate"})


def test_rebalance_recommendation_does_not_fire_callback(monkeypatch):
    logs = []
    on_interruption = MagicMock()
    # 1周目: spot/instance-action=None, events/recommendations/rebalance=検知
    watcher = make_watcher(
        monkeypatch,
        [None, {"noticeType": "rebalance"}],
        on_interruption=on_interruption,
        log=logs.append,
    )

    watcher._run()

    on_interruption.assert_not_called()
    assert any("リバランス推奨" in msg for msg in logs)


def test_no_notification_when_neither_detected(monkeypatch):
    on_interruption = MagicMock()
    watcher = make_watcher(monkeypatch, [None, None], on_interruption=on_interruption)

    watcher._run()

    on_interruption.assert_not_called()


def test_fire_is_only_triggered_once():
    on_interruption = MagicMock()
    watcher = iw.InterruptionWatcher(on_interruption, log=lambda msg: None)

    watcher._fire("spot_interruption", {"action": "terminate"})
    watcher._fire("spot_interruption", {"action": "terminate"})

    on_interruption.assert_called_once()


def test_check_error_is_logged_and_polling_continues(monkeypatch):
    logs = []
    on_interruption = MagicMock()
    watcher = iw.InterruptionWatcher(on_interruption, log=logs.append)
    monkeypatch.setattr(iw, "POLL_INTERVAL_SEC", 0)
    monkeypatch.setattr(watcher, "_get_token", lambda: "token")

    state = {"n": 0}

    def fake_check(token, path):
        state["n"] += 1
        if state["n"] == 1:
            raise RuntimeError("IMDS unavailable")
        watcher.stop()
        return None

    monkeypatch.setattr(watcher, "_check", fake_check)

    watcher._run()

    on_interruption.assert_not_called()
    assert any("確認に失敗" in msg for msg in logs)
