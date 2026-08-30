"""ゲームプロセスの探索・thprac のアタッチ・Wine の後片付け。"""

import subprocess

from recording import process
from recording_helpers import make_config
from recording_helpers import _forbidden_popen, _recording_popen


def test_attach_thprac_does_nothing_when_title_has_no_thprac(monkeypatch):
    # th06/07/08/11はthprac_exe未指定。wineを起動せず即Falseで抜けること。
    monkeypatch.setattr(process.subprocess, "Popen", _forbidden_popen)

    assert process.attach_thprac(make_config(), {}, log=lambda *a: None) is False


def test_attach_thprac_warns_and_continues_when_binary_is_missing(tmp_path, monkeypatch):
    # タイトル資産アーカイブにthpracを入れ忘れた場合。録画は続行できなければならない
    # (thprac無しの従来動作に戻るだけ、reports/50)。
    monkeypatch.setattr(process.subprocess, "Popen", _forbidden_popen)
    config = make_config(game_id="th20", instance_dir=str(tmp_path), thprac_exe="thprac.exe")
    logs = []

    assert process.attach_thprac(config, {}, log=logs.append) is False
    assert any("見つかりません" in line for line in logs)


def test_attach_thprac_attaches_without_passing_a_pid(tmp_path, monkeypatch):
    """`--attach`にPIDを渡さないことが本質(reports/50)。

    pgrepで得られるのはLinuxのPIDで、Wineがゲームに割り当てるWindows側のPIDとは
    別物のため、渡すとthpracが確認ダイアログを出したまま常駐して固まる。
    """
    (tmp_path / "thprac.exe").write_bytes(b"")
    config = make_config(game_id="th20", instance_dir=str(tmp_path), thprac_exe="thprac.exe")
    commands = []
    monkeypatch.setattr(process.subprocess, "Popen", _recording_popen(commands))
    monkeypatch.setattr(process, "find_live_game_pid", lambda name: "1234")
    monkeypatch.setattr(process, "thprac_attached", lambda pid, exe: True)

    assert process.attach_thprac(config, {}, log=lambda *a: None) is True
    assert commands == [["wine", "thprac.exe", "--attach"]]


def test_attach_thprac_reports_failure_when_image_is_not_mapped(tmp_path, monkeypatch):
    # thprac.exeが正常終了しても、ゲームプロセスにイメージが載っていなければ
    # アタッチできていない(/proc/<pid>/mapsで検証する、reports/50)。
    (tmp_path / "thprac.exe").write_bytes(b"")
    config = make_config(game_id="th20", instance_dir=str(tmp_path), thprac_exe="thprac.exe")
    monkeypatch.setattr(process.subprocess, "Popen", _recording_popen([]))
    monkeypatch.setattr(process, "find_live_game_pid", lambda name: "1234")
    monkeypatch.setattr(process, "thprac_attached", lambda pid, exe: False)

    assert process.attach_thprac(config, {}, confirm_timeout=0.0, log=lambda *a: None) is False


def test_attach_thprac_retries_when_the_first_attempt_does_not_map(tmp_path, monkeypatch):
    """ゲーム起動直後はアタッチ先として認識されず1回目が空振りすることがある
    (本番で発生、Issue #110)。試行を打ち切らずリトライすること。"""
    (tmp_path / "thprac.exe").write_bytes(b"")
    config = make_config(game_id="th20", instance_dir=str(tmp_path), thprac_exe="thprac.exe")
    commands = []
    monkeypatch.setattr(process.subprocess, "Popen", _recording_popen(commands))
    monkeypatch.setattr(process, "find_live_game_pid", lambda name: "1234")
    # 1回目のwine実行で確認したときはまだ載っておらず、2回目で載る。
    monkeypatch.setattr(process, "thprac_attached", lambda pid, exe: len(commands) >= 2)

    assert process.attach_thprac(config, {}, confirm_timeout=0.0, log=lambda *a: None) is True
    assert len(commands) == 2


def test_attach_thprac_gives_up_after_the_configured_attempts(tmp_path, monkeypatch):
    (tmp_path / "thprac.exe").write_bytes(b"")
    config = make_config(game_id="th20", instance_dir=str(tmp_path), thprac_exe="thprac.exe")
    commands = []
    monkeypatch.setattr(process.subprocess, "Popen", _recording_popen(commands))
    monkeypatch.setattr(process, "find_live_game_pid", lambda name: "1234")
    monkeypatch.setattr(process, "thprac_attached", lambda pid, exe: False)

    assert process.attach_thprac(config, {}, attempts=2, confirm_timeout=0.0, log=lambda *a: None) is False
    assert len(commands) == 2


def test_attach_thprac_logs_the_exit_code_and_output(tmp_path, monkeypatch):
    """thpracの出力と終了コードは必ずログに残す(Issue #110)。

    旧実装は両方とも捨てていたため、本番でアタッチが失敗したときにthprac自身が
    何を言っていたのかを事後に確認できなかった。"""
    (tmp_path / "thprac.exe").write_bytes(b"")
    config = make_config(game_id="th20", instance_dir=str(tmp_path), thprac_exe="thprac.exe")
    popen = _recording_popen([], output="no game found\n", returncode=1)
    monkeypatch.setattr(process.subprocess, "Popen", popen)
    monkeypatch.setattr(process, "find_live_game_pid", lambda name: "1234")
    monkeypatch.setattr(process, "thprac_attached", lambda pid, exe: True)
    logs = []

    assert process.attach_thprac(config, {}, log=logs.append) is True
    assert any("exit=1" in line for line in logs)
    assert any("no game found" in line for line in logs)


def test_attach_thprac_kills_and_stops_retrying_on_timeout(tmp_path, monkeypatch):
    """タイムアウトはthpracが確認ダイアログを出したまま常駐している可能性が高く
    (reports/50)、リトライしても同じ状態を積み増すだけなので即座に諦めること。

    アタッチは録画開始より前に行われるため、ここで粘るとリプレイ冒頭を取りこぼす
    (Issue #110)。"""
    (tmp_path / "thprac.exe").write_bytes(b"")
    config = make_config(game_id="th20", instance_dir=str(tmp_path), thprac_exe="thprac.exe")
    commands = []
    monkeypatch.setattr(process.subprocess, "Popen", _recording_popen(commands, timeout_on=(1,)))
    monkeypatch.setattr(process, "find_live_game_pid", lambda name: "1234")
    monkeypatch.setattr(process, "thprac_attached", lambda pid, exe: True)
    logs = []

    assert process.attach_thprac(config, {}, log=logs.append) is False
    assert len(commands) == 1
    assert any("タイムアウト" in line for line in logs)


def test_wait_for_thprac_attached_polls_until_the_image_appears(monkeypatch):
    """thpracプロセスの終了と注入の完了は非同期でありうるため、終了直後に1回だけ
    /proc/<pid>/mapsを読む一発勝負にしない(Issue #110)。"""
    config = make_config(game_id="th20", thprac_exe="thprac.exe")
    calls = []
    monkeypatch.setattr(process, "find_live_game_pid", lambda name: "1234")
    monkeypatch.setattr(process.time, "sleep", lambda _s: None)

    def attached(pid, exe):
        calls.append(pid)
        return len(calls) >= 3

    monkeypatch.setattr(process, "thprac_attached", attached)

    assert process.wait_for_thprac_attached(config) == "1234"
    assert len(calls) == 3


def test_wait_for_thprac_attached_returns_none_within_the_timeout(monkeypatch):
    config = make_config(game_id="th20", thprac_exe="thprac.exe")
    monkeypatch.setattr(process, "find_live_game_pid", lambda name: "1234")
    monkeypatch.setattr(process, "thprac_attached", lambda pid, exe: False)
    monkeypatch.setattr(process.time, "sleep", lambda _s: None)

    assert process.wait_for_thprac_attached(config, timeout=0.0) is None


def test_thprac_attached_detects_the_injected_image_in_proc_maps(tmp_path, monkeypatch):
    maps = tmp_path / "maps"
    maps.write_text(
        "0c540000-0c541000 r--p 00000000 00:00 0 /instance/thprac.v2.3.0.3.exe\n"
        "75670000-75671000 r--p 00000000 00:00 0 /instance/th20_hook.dll\n"
    )
    monkeypatch.setattr(
        process, "open", lambda path, *a, **k: maps.open(*a, **k), raising=False
    )

    assert process.thprac_attached("1234", "thprac.v2.3.0.3.exe") is True
    assert process.thprac_attached("1234", "thprac.v9.9.9.9.exe") is False


def test_thprac_attached_returns_false_when_the_process_is_gone():
    # PID 0 の /proc/0/maps は存在しない。OSErrorを握って False を返すこと。
    assert process.thprac_attached("0", "thprac.exe") is False


def test_kill_wine_and_wait_sigkills_leftover_processes_on_timeout(monkeypatch):
    """`wineserver -w`がD state対策のタイムアウトに達した場合、このWINEPREFIX配下の
    残存プロセスをSIGKILLへフォールバックすること(2026-08-27インシデント)。"""
    config = make_config(wineprefix="/prefix/th20-a")
    run_calls = []

    def fake_run(cmd, **kwargs):
        run_calls.append(cmd)
        if cmd[:2] == ["wineserver", "-w"]:
            raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout"))
        return type("Result", (), {"returncode": 0})()

    killed = []
    monkeypatch.setattr(process.subprocess, "run", fake_run)
    monkeypatch.setattr(process, "_find_pids_with_wineprefix", lambda wineprefix: [111, 222])
    monkeypatch.setattr(process.os, "kill", lambda pid, sig: killed.append((pid, sig)))

    logs = []
    process.kill_wine_and_wait(config, {}, config.process_name, log=logs.append)

    assert killed == [(111, process.signal.SIGKILL), (222, process.signal.SIGKILL)]
    assert any("WARNING" in msg and "SIGKILL" in msg for msg in logs)


def test_kill_wine_and_wait_ignores_already_dead_leftover_processes(monkeypatch):
    """SIGKILL対象がSIGKILL送信前にすでに終了していても(通常のプロセス終了との
    レース)例外にせず後片付けを完走すること。"""
    config = make_config()

    def fake_run(cmd, **kwargs):
        if cmd[:2] == ["wineserver", "-w"]:
            raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout"))
        return type("Result", (), {"returncode": 0})()

    monkeypatch.setattr(process.subprocess, "run", fake_run)
    monkeypatch.setattr(process, "_find_pids_with_wineprefix", lambda wineprefix: [999])

    def fake_kill(pid, sig):
        raise ProcessLookupError()

    monkeypatch.setattr(process.os, "kill", fake_kill)

    # 例外を送出しないこと。
    process.kill_wine_and_wait(config, {}, config.process_name, log=lambda msg: None)
