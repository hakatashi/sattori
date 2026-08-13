import json
import subprocess

import numpy as np
import pytest
from PIL import Image

import recording_common as rc


@pytest.fixture(autouse=True)
def fake_job_sink(monkeypatch):
    """テスト中に実際のpactl(PulseAudio)を叩かせない。

    record_with_retry()がジョブ専用sinkを作成・破棄する(Issue #48)ため、pulse側の
    pactl実行部分だけを差し替え、呼び出し履歴を返す(sinkのライフサイクル自体は
    本物のpulse.job_sink()を通す)。
    """
    events = []

    def create_null_sink(sink_name, log=print):
        events.append(("create", sink_name))
        return "42"

    def unload_module(module_id, log=print):
        events.append(("unload", module_id))
        return True

    monkeypatch.setattr(rc.pulse, "create_null_sink", create_null_sink)
    monkeypatch.setattr(rc.pulse, "unload_module", unload_module)
    return events


def make_config(**overrides):
    kwargs = dict(
        game_id="th08",
        pulse_sink="sattori_job_test",
        display=":98",
        wineprefix="/prefix",
        instance_dir="/instance",
        game_dir_src="/game",
        canonical_slot="th8_ud0000.rpy",
        injector_path="/mods/common/build/injector.exe",
        hook_dll_path="/mods/th08_replay_autoplay/build/th08_hook.dll",
    )
    kwargs.update(overrides)
    return rc.GameConfig(**kwargs)


def _forbidden_popen(*args, **kwargs):
    raise AssertionError(f"外部プロセスを起動してはならない: {args!r}")


def _recording_popen(commands, output="", returncode=0, timeout_on=()):
    """subprocess.Popenの差し替え。起動コマンドをcommandsへ記録し、即座に正常終了した
    ことにするダミーのプロセスハンドルを返す。

    `timeout_on`に含まれる試行回数(1始まり)では`communicate()`が
    `subprocess.TimeoutExpired`を送出する(thpracが確認ダイアログを出して常駐した
    ケースの再現、Issue #110)。"""
    class _Proc:
        def __init__(self, attempt):
            self._attempt = attempt
            self._killed = False
            self.returncode = returncode

        def wait(self, timeout=None):
            return returncode

        def communicate(self, timeout=None):
            if self._attempt in timeout_on and not self._killed:
                raise subprocess.TimeoutExpired("wine", timeout)
            return output, None

        def kill(self):
            self._killed = True

    def popen(cmd, *args, **kwargs):
        commands.append(list(cmd))
        return _Proc(len(commands))

    return popen


def test_game_config_derives_exe_dll_and_log_path_from_game_id():
    config = make_config()

    assert config.game_exe == "th08.exe"
    assert config.hook_dll == "th08_hook.dll"
    assert config.log_path == "/instance/th08_autoplay.log"


def test_game_config_extra_dlls_defaults_to_empty():
    config = make_config()

    assert config.extra_dlls == ()


def test_game_config_process_name_defaults_to_game_exe():
    config = make_config()

    assert config.process_name == config.game_exe == "th08.exe"


def test_game_config_allows_overriding_game_exe_and_process_name():
    # th06はVsyncPatchが実行ファイル名を検証しているらしく、th{N}.exeへリネームすると
    # 白画面ハングが再発するため元のファイル名のまま使う(record_th06.pyのモジュール
    # docstring参照)。/proc/PID/commは15バイトで切り詰められるため、pgrep/pkill専用の
    # process_nameは拡張子なしの別の値を指定する(touhou-recorder reports/31)。
    config = make_config(
        game_id="th06", game_exe="東方紅魔郷.exe", process_name="東方紅魔郷",
    )

    assert config.game_exe == "東方紅魔郷.exe"
    assert config.process_name == "東方紅魔郷"


def test_build_injector_cmd_without_extra_dlls():
    config = make_config()

    cmd = rc.build_injector_cmd(config)

    assert cmd == ["wine", "injector.exe", "th08.exe", "th08_hook.dll"]


def test_build_injector_cmd_injects_extra_dlls_before_hook_dll():
    # th06のVsyncPatch(vpatch_th06.dll)はwined3dの白画面ハングを避けるため、
    # MOD本体(hook_dll)より前に注入されなければならない(touhou-recorder reports/30)。
    config = make_config(game_id="th06", extra_dlls=("vpatch_th06.dll",))

    cmd = rc.build_injector_cmd(config)

    assert cmd == ["wine", "injector.exe", "th06.exe", "vpatch_th06.dll", "th06_hook.dll"]


def test_game_config_build_env_sets_wine_and_locale_vars():
    config = make_config()

    env = config.build_env()

    assert env["WINEPREFIX"] == "/prefix"
    assert env["DISPLAY"] == ":98"
    assert env["LANG"] == "ja_JP.UTF-8"
    assert env["LC_ALL"] == "ja_JP.UTF-8"
    # Wineの音声出力先をジョブ専用sinkへ固定する(Issue #48)。無指定だとデフォルトsinkへ
    # 流れ、同一ホストでの並列録画で全ジョブの音声が混ざる。
    assert env["PULSE_SINK"] == "sattori_job_test"


def test_game_config_derives_pulse_source_from_pulse_sink():
    # 録音側ffmpegの入力はジョブ専用sinkのmonitor(タイトル固定の`auto_null.monitor`では
    # なくなった、Issue #48)。
    config = make_config(pulse_sink="sattori_job_abc")

    assert config.pulse_source == "sattori_job_abc.monitor"


def test_mad_zero_for_identical_frames():
    a = np.zeros((4, 4), dtype=np.float32)
    assert rc.mad(a, a) == 0.0


def test_mad_computes_mean_absolute_difference():
    a = np.array([[0.0, 0.0], [0.0, 0.0]], dtype=np.float32)
    b = np.array([[2.0, 4.0], [0.0, 2.0]], dtype=np.float32)
    assert rc.mad(a, b) == pytest.approx(2.0)


def test_build_still_mask_returns_none_when_rect_is_none():
    assert rc.build_still_mask(None, 640, 480) is None


def test_build_still_mask_excludes_rect_scaled_to_160x120(tmp_path):
    # th11のPause Menu画面選択カーソル明滅矩形(元のウィンドウ座標系(70,288)-(188,318)、
    # touhou-recorder reports/37・38)を640x480ウィンドウで変換すると、160x120座標系では
    # おおよそx=[17,47) y=[72,80)になる。
    mask = rc.build_still_mask((70, 288, 188, 318), 640, 480)

    assert mask.shape == (120, 160)
    assert mask[75, 30] == False  # noqa: E712 - 矩形内は除外(False)
    assert mask[0, 0] == True  # noqa: E712 - 矩形外は静止判定に使う(True)


def test_mad_masked_falls_back_to_mad_when_mask_is_none():
    a = np.array([[0.0, 0.0], [0.0, 0.0]], dtype=np.float32)
    b = np.array([[2.0, 4.0], [0.0, 2.0]], dtype=np.float32)

    assert rc.mad_masked(a, b, None) == pytest.approx(rc.mad(a, b))


def test_mad_masked_ignores_differences_inside_excluded_mask():
    a = np.zeros((4, 4), dtype=np.float32)
    b = np.zeros((4, 4), dtype=np.float32)
    b[0, 0] = 100.0  # マスクで除外される画素だけが変化(=明滅カーソル相当)
    mask = np.ones((4, 4), dtype=bool)
    mask[0, 0] = False

    assert rc.mad_masked(a, b, mask) == pytest.approx(0.0)


def test_game_config_still_detect_exclude_rect_defaults_to_none():
    config = make_config()

    assert config.still_detect_exclude_rect is None


def test_game_config_allows_overriding_still_detect_exclude_rect():
    config = make_config(game_id="th11", still_detect_exclude_rect=(70, 288, 188, 318))

    assert config.still_detect_exclude_rect == (70, 288, 188, 318)


def test_game_config_end_template_path_defaults_next_to_module():
    # 未指定ならrecording_common.pyと同じディレクトリ配下のassets/replay_end_templates/
    # {game_id}.pngを既定値として使う(record_th0X.py側での明示指定は不要、reports/33・34)。
    config = make_config(game_id="th07")

    assert config.end_template_path.endswith("/assets/replay_end_templates/th07.png")


def test_game_config_allows_overriding_end_template_path():
    config = make_config(end_template_path="/custom/th08.png")

    assert config.end_template_path == "/custom/th08.png"


def test_game_config_thprac_exe_defaults_to_none():
    config = make_config()

    assert config.thprac_exe is None


def test_attach_thprac_does_nothing_when_title_has_no_thprac(monkeypatch):
    # th06/07/08/11はthprac_exe未指定。wineを起動せず即Falseで抜けること。
    monkeypatch.setattr(rc.subprocess, "Popen", _forbidden_popen)

    assert rc.attach_thprac(make_config(), {}, log=lambda *a: None) is False


def test_attach_thprac_warns_and_continues_when_binary_is_missing(tmp_path, monkeypatch):
    # タイトル資産アーカイブにthpracを入れ忘れた場合。録画は続行できなければならない
    # (thprac無しの従来動作に戻るだけ、reports/50)。
    monkeypatch.setattr(rc.subprocess, "Popen", _forbidden_popen)
    config = make_config(game_id="th20", instance_dir=str(tmp_path), thprac_exe="thprac.exe")
    logs = []

    assert rc.attach_thprac(config, {}, log=logs.append) is False
    assert any("見つかりません" in line for line in logs)


def test_attach_thprac_attaches_without_passing_a_pid(tmp_path, monkeypatch):
    """`--attach`にPIDを渡さないことが本質(reports/50)。

    pgrepで得られるのはLinuxのPIDで、Wineがゲームに割り当てるWindows側のPIDとは
    別物のため、渡すとthpracが確認ダイアログを出したまま常駐して固まる。
    """
    (tmp_path / "thprac.exe").write_bytes(b"")
    config = make_config(game_id="th20", instance_dir=str(tmp_path), thprac_exe="thprac.exe")
    commands = []
    monkeypatch.setattr(rc.subprocess, "Popen", _recording_popen(commands))
    monkeypatch.setattr(rc, "find_live_game_pid", lambda name: "1234")
    monkeypatch.setattr(rc, "thprac_attached", lambda pid, exe: True)

    assert rc.attach_thprac(config, {}, log=lambda *a: None) is True
    assert commands == [["wine", "thprac.exe", "--attach"]]


def test_attach_thprac_reports_failure_when_image_is_not_mapped(tmp_path, monkeypatch):
    # thprac.exeが正常終了しても、ゲームプロセスにイメージが載っていなければ
    # アタッチできていない(/proc/<pid>/mapsで検証する、reports/50)。
    (tmp_path / "thprac.exe").write_bytes(b"")
    config = make_config(game_id="th20", instance_dir=str(tmp_path), thprac_exe="thprac.exe")
    monkeypatch.setattr(rc.subprocess, "Popen", _recording_popen([]))
    monkeypatch.setattr(rc, "find_live_game_pid", lambda name: "1234")
    monkeypatch.setattr(rc, "thprac_attached", lambda pid, exe: False)

    assert rc.attach_thprac(config, {}, confirm_timeout=0.0, log=lambda *a: None) is False


def test_attach_thprac_retries_when_the_first_attempt_does_not_map(tmp_path, monkeypatch):
    """ゲーム起動直後はアタッチ先として認識されず1回目が空振りすることがある
    (本番で発生、Issue #110)。試行を打ち切らずリトライすること。"""
    (tmp_path / "thprac.exe").write_bytes(b"")
    config = make_config(game_id="th20", instance_dir=str(tmp_path), thprac_exe="thprac.exe")
    commands = []
    monkeypatch.setattr(rc.subprocess, "Popen", _recording_popen(commands))
    monkeypatch.setattr(rc, "find_live_game_pid", lambda name: "1234")
    # 1回目のwine実行で確認したときはまだ載っておらず、2回目で載る。
    monkeypatch.setattr(rc, "thprac_attached", lambda pid, exe: len(commands) >= 2)

    assert rc.attach_thprac(config, {}, confirm_timeout=0.0, log=lambda *a: None) is True
    assert len(commands) == 2


def test_attach_thprac_gives_up_after_the_configured_attempts(tmp_path, monkeypatch):
    (tmp_path / "thprac.exe").write_bytes(b"")
    config = make_config(game_id="th20", instance_dir=str(tmp_path), thprac_exe="thprac.exe")
    commands = []
    monkeypatch.setattr(rc.subprocess, "Popen", _recording_popen(commands))
    monkeypatch.setattr(rc, "find_live_game_pid", lambda name: "1234")
    monkeypatch.setattr(rc, "thprac_attached", lambda pid, exe: False)

    assert rc.attach_thprac(config, {}, attempts=2, confirm_timeout=0.0, log=lambda *a: None) is False
    assert len(commands) == 2


def test_attach_thprac_logs_the_exit_code_and_output(tmp_path, monkeypatch):
    """thpracの出力と終了コードは必ずログに残す(Issue #110)。

    旧実装は両方とも捨てていたため、本番でアタッチが失敗したときにthprac自身が
    何を言っていたのかを事後に確認できなかった。"""
    (tmp_path / "thprac.exe").write_bytes(b"")
    config = make_config(game_id="th20", instance_dir=str(tmp_path), thprac_exe="thprac.exe")
    popen = _recording_popen([], output="no game found\n", returncode=1)
    monkeypatch.setattr(rc.subprocess, "Popen", popen)
    monkeypatch.setattr(rc, "find_live_game_pid", lambda name: "1234")
    monkeypatch.setattr(rc, "thprac_attached", lambda pid, exe: True)
    logs = []

    assert rc.attach_thprac(config, {}, log=logs.append) is True
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
    monkeypatch.setattr(rc.subprocess, "Popen", _recording_popen(commands, timeout_on=(1,)))
    monkeypatch.setattr(rc, "find_live_game_pid", lambda name: "1234")
    monkeypatch.setattr(rc, "thprac_attached", lambda pid, exe: True)
    logs = []

    assert rc.attach_thprac(config, {}, log=logs.append) is False
    assert len(commands) == 1
    assert any("タイムアウト" in line for line in logs)


def test_wait_for_thprac_attached_polls_until_the_image_appears(monkeypatch):
    """thpracプロセスの終了と注入の完了は非同期でありうるため、終了直後に1回だけ
    /proc/<pid>/mapsを読む一発勝負にしない(Issue #110)。"""
    config = make_config(game_id="th20", thprac_exe="thprac.exe")
    calls = []
    monkeypatch.setattr(rc, "find_live_game_pid", lambda name: "1234")
    monkeypatch.setattr(rc.time, "sleep", lambda _s: None)

    def attached(pid, exe):
        calls.append(pid)
        return len(calls) >= 3

    monkeypatch.setattr(rc, "thprac_attached", attached)

    assert rc.wait_for_thprac_attached(config) == "1234"
    assert len(calls) == 3


def test_wait_for_thprac_attached_returns_none_within_the_timeout(monkeypatch):
    config = make_config(game_id="th20", thprac_exe="thprac.exe")
    monkeypatch.setattr(rc, "find_live_game_pid", lambda name: "1234")
    monkeypatch.setattr(rc, "thprac_attached", lambda pid, exe: False)
    monkeypatch.setattr(rc.time, "sleep", lambda _s: None)

    assert rc.wait_for_thprac_attached(config, timeout=0.0) is None


def test_thprac_attached_detects_the_injected_image_in_proc_maps(tmp_path, monkeypatch):
    maps = tmp_path / "maps"
    maps.write_text(
        "0c540000-0c541000 r--p 00000000 00:00 0 /instance/thprac.v2.3.0.3.exe\n"
        "75670000-75671000 r--p 00000000 00:00 0 /instance/th20_hook.dll\n"
    )
    monkeypatch.setattr(
        rc, "open", lambda path, *a, **k: maps.open(*a, **k), raising=False
    )

    assert rc.thprac_attached("1234", "thprac.v2.3.0.3.exe") is True
    assert rc.thprac_attached("1234", "thprac.v9.9.9.9.exe") is False


def test_thprac_attached_returns_false_when_the_process_is_gone():
    # PID 0 の /proc/0/maps は存在しない。OSErrorを握って False を返すこと。
    assert rc.thprac_attached("0", "thprac.exe") is False


def test_load_end_template_returns_none_when_path_is_none():
    assert rc.load_end_template(None) is None


def test_load_end_template_returns_none_when_file_missing(tmp_path):
    assert rc.load_end_template(str(tmp_path / "missing.png")) is None


def test_load_end_template_crops_top_band_at_downsampled_resolution(tmp_path):
    # grab_frame()と同じ160x120グレースケールへダウンサンプルした上で、リプレイ内容に
    # 依存しない上部の帯(END_TEMPLATE_ROWS)だけを切り出す(reports/33)。
    path = tmp_path / "template.png"
    Image.new("RGB", (640, 480), color=(100, 150, 200)).save(path)

    template = rc.load_end_template(str(path))

    assert template.shape == (rc.END_TEMPLATE_ROWS, 160)


def test_load_end_template_is_content_independent_of_lower_region(tmp_path):
    # フェーズ34: 切り出し領域(タイトル文言+列見出しの帯)はリプレイ一覧の中身
    # (プレイヤー名・日付等、画像下部)に依存しないことを確認する。
    img_a = Image.new("RGB", (640, 480), color=(255, 255, 255))
    for y in range(400, 480):
        for x in range(0, 640, 10):
            img_a.putpixel((x, y), (0, 0, 0))
    path_a = tmp_path / "a.png"
    img_a.save(path_a)

    img_b = Image.new("RGB", (640, 480), color=(255, 255, 255))
    path_b = tmp_path / "b.png"
    img_b.save(path_b)

    template_a = rc.load_end_template(str(path_a))
    template_b = rc.load_end_template(str(path_b))

    assert rc.mad(template_a, template_b) == pytest.approx(0.0)


def test_build_video_ffmpeg_cmd_captures_without_watermark():
    # ウォーターマークはmux_audio_video()側で合成するため、build_video_ffmpeg_cmd()は
    # 常にウォーターマークなしの生キャプチャコマンドを返す(-copytsとoverlayの
    # フレーム同期不具合を避けるため、reports/28参照)。
    config = make_config()
    cmd = rc.build_video_ffmpeg_cmd(config, 0, 0, 640, 480, "out.video.mp4")

    assert cmd[0] == "ffmpeg"
    assert "-filter_complex" not in cmd
    assert "-f" in cmd and "pulse" not in cmd  # 音声は別プロセス(reports/26)
    assert cmd[-1] == "out.video.mp4"
    assert "libx264" in cmd
    assert "640x480" in cmd
    assert "-copyts" in cmd  # A/V同期補正用の絶対start_time保持(reports/28)


def test_build_audio_ffmpeg_cmd_uses_pulse_source():
    config = make_config()
    cmd = rc.build_audio_ffmpeg_cmd(config, "out.audio.m4a")

    assert cmd[0] == "ffmpeg"
    assert "pulse" in cmd
    assert config.pulse_source in cmd
    assert cmd[-1] == "out.audio.m4a"
    assert "-copyts" in cmd  # A/V同期補正用の絶対start_time保持(reports/28)


def test_ffprobe_start_time_parses_ffprobe_output(monkeypatch):
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return type("Result", (), {"stdout": "1784765161.591758\n"})()

    monkeypatch.setattr(rc.subprocess, "run", fake_run)

    result = rc.ffprobe_start_time("video.mp4", {})

    assert result == pytest.approx(1784765161.591758)
    assert captured["cmd"][0] == "ffprobe"
    assert "video.mp4" in captured["cmd"]


def test_ffprobe_start_time_returns_none_on_unparsable_output(monkeypatch):
    monkeypatch.setattr(
        rc.subprocess, "run", lambda cmd, **kwargs: type("Result", (), {"stdout": "N/A\n"})()
    )

    assert rc.ffprobe_start_time("video.mp4", {}) is None


def test_mux_audio_video_delays_later_starting_audio(monkeypatch):
    monkeypatch.setattr(
        rc, "ffprobe_start_time",
        lambda path, env: 100.0 if "video" in path else 100.6,
    )
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return type("Result", (), {"returncode": 0, "stderr": b""})()

    monkeypatch.setattr(rc.subprocess, "run", fake_run)

    ok = rc.mux_audio_video("video.mp4", "audio.m4a", "out.mp4", {}, log=lambda msg: None)

    assert ok is True
    cmd = captured["cmd"]
    # 音声(audio.m4a)が0.6秒遅く開始したため、mux時にaudio側へ-itsoffsetを与えて補正する
    audio_idx = cmd.index("audio.m4a")
    assert cmd[audio_idx - 3] == "-itsoffset"
    assert float(cmd[audio_idx - 2]) == pytest.approx(0.6)
    video_idx = cmd.index("video.mp4")
    assert cmd[video_idx - 1] != "-itsoffset"


def test_mux_audio_video_delays_later_starting_video(monkeypatch):
    monkeypatch.setattr(
        rc, "ffprobe_start_time",
        lambda path, env: 100.6 if "video" in path else 100.0,
    )
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return type("Result", (), {"returncode": 0, "stderr": b""})()

    monkeypatch.setattr(rc.subprocess, "run", fake_run)

    rc.mux_audio_video("video.mp4", "audio.m4a", "out.mp4", {}, log=lambda msg: None)

    cmd = captured["cmd"]
    video_idx = cmd.index("video.mp4")
    assert cmd[video_idx - 3] == "-itsoffset"
    assert float(cmd[video_idx - 2]) == pytest.approx(0.6)


def test_mux_audio_video_skips_offset_when_start_time_unavailable(monkeypatch):
    monkeypatch.setattr(rc, "ffprobe_start_time", lambda path, env: None)
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return type("Result", (), {"returncode": 0, "stderr": b""})()

    monkeypatch.setattr(rc.subprocess, "run", fake_run)

    rc.mux_audio_video("video.mp4", "audio.m4a", "out.mp4", {}, log=lambda msg: None)

    assert "-itsoffset" not in captured["cmd"]


def test_mux_audio_video_uses_stream_copy(monkeypatch):
    # ウォーターマークはこの関数(録画直後のmux)では合成しない。x11grabの生ptsが
    # wallclockベース(実epoch秒)のまま`-copyts`でfiltergraphに渡ると、ほぼ0起点の
    # ウォーターマーク動画とoverlayのフレーム同期が噛み合わず不発になる不具合が
    # あったため、ウォーターマーク合成はconvert.py側(配信用変換と同時)に移した。
    monkeypatch.setattr(rc, "ffprobe_start_time", lambda path, env: None)
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return type("Result", (), {"returncode": 0, "stderr": b""})()

    monkeypatch.setattr(rc.subprocess, "run", fake_run)

    rc.mux_audio_video("video.mp4", "audio.m4a", "out.mp4", {}, log=lambda msg: None)

    cmd = captured["cmd"]
    assert "-filter_complex" not in cmd
    assert "copy" in cmd


def test_save_progress_snapshot_writes_frame_and_state_atomically(tmp_path):
    color = Image.new("RGB", (640, 480), color=(10, 20, 30))

    rc.save_progress_snapshot(str(tmp_path), color, elapsed_seconds=12.3, expected_duration_seconds=60)

    assert (tmp_path / "frame.jpg").exists()
    assert not (tmp_path / "frame.jpg.tmp").exists()
    assert not (tmp_path / "state.json.tmp").exists()
    state = json.loads((tmp_path / "state.json").read_text())
    assert state == {"elapsedSeconds": 12.3, "expectedDurationSeconds": 60}


def test_wait_for_log_marker_finds_existing_marker(tmp_path):
    log_path = tmp_path / "th08_autoplay.log"
    log_path.write_text("some other line\nWaitForStableWindow: stable\n")

    result = rc.wait_for_log_marker(str(log_path), "WaitForStableWindow: stable", timeout=1, poll_interval=0.01)

    assert result is not None


def test_wait_for_log_marker_times_out_when_absent(tmp_path):
    log_path = tmp_path / "th08_autoplay.log"
    log_path.write_text("unrelated log line\n")

    result = rc.wait_for_log_marker(str(log_path), "WaitForStableWindow: stable", timeout=0.05, poll_interval=0.01)

    assert result is None


def test_wait_for_log_marker_times_out_when_log_file_missing(tmp_path):
    result = rc.wait_for_log_marker(
        str(tmp_path / "does-not-exist.log"), "WaitForStableWindow: stable", timeout=0.05, poll_interval=0.01
    )

    assert result is None


def test_scan_fps_runaway_returns_none_when_log_missing(tmp_path):
    assert rc.scan_fps_runaway(str(tmp_path / "missing.log")) is None


def test_scan_fps_runaway_ignores_values_at_or_below_threshold(tmp_path):
    log_path = tmp_path / "th08_autoplay.log"
    log_path.write_text(
        "FpsMonitor: 300 GetDeviceState calls in 5006 ms (59.9 Hz)\n"
        "FpsMonitor: 300 GetDeviceState calls in 5004 ms (60.0 Hz)\n"
    )

    assert rc.scan_fps_runaway(str(log_path)) is None


def test_scan_fps_runaway_ignores_single_spike_below_consecutive_requirement(tmp_path):
    # reports/23: 単発のノイズ(実測最大118Hz、直後に正常値へ復帰)は誤検知しない。
    log_path = tmp_path / "th08_autoplay.log"
    log_path.write_text(
        "FpsMonitor: 300 GetDeviceState calls in 5006 ms (59.9 Hz)\n"
        "FpsMonitor: 300 GetDeviceState calls in 2500 ms (118.1 Hz)\n"
        "FpsMonitor: 300 GetDeviceState calls in 5004 ms (60.1 Hz)\n"
    )

    assert rc.scan_fps_runaway(str(log_path)) is None


def test_scan_fps_runaway_detects_two_consecutive_spikes(tmp_path):
    # reports/22: fps暴走は実測479〜2700Hzがリプレイ全編にわたり持続する。
    log_path = tmp_path / "th08_autoplay.log"
    log_path.write_text(
        "FpsMonitor: 300 GetDeviceState calls in 5006 ms (59.9 Hz)\n"
        "FpsMonitor: 300 GetDeviceState calls in 100 ms (900.0 Hz)\n"
        "FpsMonitor: 300 GetDeviceState calls in 110 ms (850.0 Hz)\n"
    )

    assert rc.scan_fps_runaway(str(log_path)) == pytest.approx(900.0)


def test_record_with_retry_gives_up_after_max_attempts(monkeypatch):
    config = make_config()
    monkeypatch.setattr(rc, "attempt_recording", lambda *a, **k: {
        "output_exists": False, "classification": "setup_error", "fps_runaway_hz": None, "total_record_sec": 0.0,
    })

    success = rc.record_with_retry(config, "/replay.rpy", "/out.mp4", max_attempts=2, log=lambda msg: None)

    assert success is False


def test_record_with_retry_retries_on_fps_runaway_then_succeeds(monkeypatch):
    config = make_config()
    calls = []

    def fake_attempt(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            return {"output_exists": True, "classification": "fps_runaway", "fps_runaway_hz": 900.0, "total_record_sec": 5.0}
        return {"output_exists": True, "classification": "good", "fps_runaway_hz": None, "total_record_sec": 60.0}

    monkeypatch.setattr(rc, "attempt_recording", fake_attempt)
    monkeypatch.setattr(rc, "measure_duplicate_rate", lambda *a, **k: 1.0)

    success = rc.record_with_retry(config, "/replay.rpy", "/out.mp4", max_attempts=3, log=lambda msg: None)

    assert success is True
    assert len(calls) == 2


def test_record_with_retry_discards_output_above_max_duplicate_rate(monkeypatch):
    config = make_config()
    monkeypatch.setattr(rc, "attempt_recording", lambda *a, **k: {
        "output_exists": True, "classification": "good", "fps_runaway_hz": None, "total_record_sec": 60.0,
    })
    monkeypatch.setattr(rc, "measure_duplicate_rate", lambda *a, **k: 90.0)

    success = rc.record_with_retry(
        config, "/replay.rpy", "/out.mp4", max_attempts=1, max_duplicate_rate=30.0, log=lambda msg: None
    )

    assert success is False


def test_record_with_retry_creates_and_destroys_job_sink(monkeypatch, fake_job_sink):
    # ジョブ専用sinkは録画開始時に作成し、終了時に必ず破棄する(Issue #48)。
    config = make_config(pulse_sink="sattori_job_abc")
    monkeypatch.setattr(rc, "attempt_recording", lambda *a, **k: {
        "output_exists": True, "classification": "good", "fps_runaway_hz": None, "total_record_sec": 60.0,
    })
    monkeypatch.setattr(rc, "measure_duplicate_rate", lambda *a, **k: 1.0)

    success = rc.record_with_retry(config, "/replay.rpy", "/out.mp4", max_attempts=1, log=lambda msg: None)

    assert success is True
    assert fake_job_sink == [("create", "sattori_job_abc"), ("unload", "42")]


def test_record_with_retry_destroys_job_sink_when_recording_fails(monkeypatch, fake_job_sink):
    # 失敗時に残った孤児sinkは、次のジョブで同名sinkが`<名前>.2`にリネームされる原因に
    # なるため、成功・失敗を問わず破棄する。
    config = make_config(pulse_sink="sattori_job_abc")
    monkeypatch.setattr(rc, "attempt_recording", lambda *a, **k: {
        "output_exists": False, "classification": "setup_error", "fps_runaway_hz": None, "total_record_sec": 0.0,
    })

    success = rc.record_with_retry(config, "/replay.rpy", "/out.mp4", max_attempts=2, log=lambda msg: None)

    assert success is False
    assert fake_job_sink == [("create", "sattori_job_abc"), ("unload", "42")]


def test_record_with_retry_reuses_single_sink_across_attempts(monkeypatch, fake_job_sink):
    config = make_config(pulse_sink="sattori_job_abc")
    calls = []

    def fake_attempt(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            return {"output_exists": True, "classification": "stutter", "fps_runaway_hz": None, "total_record_sec": 5.0}
        return {"output_exists": True, "classification": "good", "fps_runaway_hz": None, "total_record_sec": 60.0}

    monkeypatch.setattr(rc, "attempt_recording", fake_attempt)
    monkeypatch.setattr(rc, "measure_duplicate_rate", lambda *a, **k: 1.0)

    assert rc.record_with_retry(config, "/replay.rpy", "/out.mp4", max_attempts=3, log=lambda msg: None) is True
    assert len(calls) == 2
    assert [event for event, _ in fake_job_sink] == ["create", "unload"]


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
    monkeypatch.setattr(rc, "find_window", lambda *a, **k: reads.pop(0))

    geom = rc.wait_for_stable_geometry(
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

    monkeypatch.setattr(rc, "find_window", never_stable)
    logs = []

    geom = rc.wait_for_stable_geometry(
        make_config(), {}, 123, log=logs.append, settle_sec=0, timeout=0.05
    )

    assert geom == (counter["n"], counter["n"], 640, 480, "w1")
    assert any("安定しませんでした" in m for m in logs)


def test_wait_for_stable_geometry_returns_none_when_window_never_found(monkeypatch):
    monkeypatch.setattr(rc, "find_window", lambda *a, **k: None)
    logs = []

    geom = rc.wait_for_stable_geometry(
        make_config(), {}, 123, log=logs.append, settle_sec=0, timeout=0.05
    )

    assert geom is None


# --- 低速録画(Issue #68) ---------------------------------------------------


def test_slow_motion_scale_is_one_when_env_is_absent():
    """`FPS_LIMIT_TARGET_HZ`未設定＝等倍録画。全タイトル共通の既定動作。"""
    assert rc.slow_motion_scale({}) == 1.0


def test_slow_motion_scale_doubles_at_half_frame_rate():
    # 30Hz駆動＝ゲーム内時間の2倍の実時間がかかる(touhou-recorder reports/47)。
    assert rc.slow_motion_scale({"FPS_LIMIT_TARGET_HZ": "30"}) == pytest.approx(2.0)


@pytest.mark.parametrize("value", ["", "0", "-30", "abc", "60", "120"])
def test_slow_motion_scale_clamps_invalid_or_non_slowing_values_to_one(value):
    """不正値・等倍以上はすべて1.0へ丸める。

    このスケールは「ゲームを遅くしたぶん監視側の時間も伸ばす」ためのものなので、
    1.0未満になるとタイムアウトが本来より短くなり、正常な録画を誤って打ち切る。
    """
    assert rc.slow_motion_scale({"FPS_LIMIT_TARGET_HZ": value}) == 1.0


def test_scaled_poll_count_is_unchanged_for_normal_speed_recordings():
    assert rc.scaled_poll_count(rc.STILL_CONSECUTIVE_REQUIRED, 1.0) == 8
    assert rc.scaled_poll_count(rc.END_TEMPLATE_CONSECUTIVE_REQUIRED, 1.0) == 2


def test_scaled_poll_count_keeps_the_required_duration_in_game_time():
    """終了検知の連続回数は「実時間の長さ」なので、低速録画では伸ばす必要がある。

    据え置くと、th20(低速録画で唯一のタイトルかつ終了検知テンプレートを持たない)で
    必要な静止が16秒→ゲーム内8秒相当まで縮み、会話イベント等でリプレイ途中を
    終了と誤判定する。しかも classification は "good" になるためリトライされない。
    """
    assert rc.scaled_poll_count(rc.STILL_CONSECUTIVE_REQUIRED, 2.0) == 16
    assert rc.scaled_poll_count(rc.END_TEMPLATE_CONSECUTIVE_REQUIRED, 2.0) == 4


def test_scaled_poll_count_rounds_up_so_the_condition_never_loosens():
    assert rc.scaled_poll_count(3, 1.5) == 5  # 4.5 -> 5


# --- th20 向けの GameConfig 拡張(Issue #87) --------------------------------


def test_xvfb_screen_defaults_to_shared_value_and_can_be_overridden():
    assert make_config().xvfb_screen == rc.XVFB_SCREEN
    assert make_config(xvfb_screen="1400x1100x24").xvfb_screen == "1400x1100x24"


def test_cfg_filename_defaults_to_game_id():
    assert make_config(game_id="th20").cfg_filename == "th20.cfg"


def test_resolve_appdata_dir_uses_the_running_unix_user(monkeypatch):
    """資産アーカイブを作った開発機のユーザー名ではなく、実行中のユーザーで解決する。

    Wineはプロファイルを`drive_c/users/<UNIXユーザー名>`にマッピングするため、
    ここを決め打ちにするとrootで動く本番コンテナがcfgを見つけられない
    (touhou-recorder reports/46 のバグ1と同じ症状)。
    """
    monkeypatch.setattr(rc.getpass, "getuser", lambda: "root")
    config = make_config(game_id="th20", wineprefix="/prefix/th20-wined3d-gl")

    assert rc.resolve_appdata_dir(config) == (
        "/prefix/th20-wined3d-gl/drive_c/users/root/AppData/Roaming/ShanghaiAlice/th20"
    )


def test_build_still_mask_accepts_multiple_rects():
    """th20はリプレイ終了後に2箇所でアニメーションが継続する(reports/45)。"""
    mask = rc.build_still_mask(
        [(0, 0, 320, 240), (960, 720, 1280, 960)], 1280, 960
    )

    assert mask[10, 10] == False  # noqa: E712 - 1つ目の矩形内
    assert mask[110, 150] == False  # noqa: E712 - 2つ目の矩形内
    assert mask[60, 80] == True  # noqa: E712 - どちらの矩形にも入らない


def test_build_still_mask_still_accepts_a_single_rect_tuple():
    """既存タイトル(th11)の単一矩形指定は従来どおり動く。"""
    mask = rc.build_still_mask((70, 288, 188, 318), 640, 480)

    assert mask[75, 30] == False  # noqa: E712
    assert mask[0, 0] == True  # noqa: E712


# --- 重複フレーム率の閾値換算(Issue #68) ----------------------------------


def test_duplicate_rate_threshold_is_unchanged_for_normal_speed_recordings():
    """等倍(scale=1)では換算しても値が変わらない＝既存タイトルの判定は不変。"""
    assert rc.duplicate_rate_threshold_for_raw(30.0, 1.0) == 30.0


def test_duplicate_rate_threshold_accounts_for_the_frames_slow_motion_duplicates():
    """1/2倍速の生データは、完璧に目標fpsを維持していても重複50%になる。

    等倍換算の閾値30%は、生データでは65%に相当する。
    """
    assert rc.duplicate_rate_threshold_for_raw(30.0, 2.0) == pytest.approx(65.0)


def test_duplicate_rate_threshold_passes_a_healthy_slow_motion_recording():
    # 目標fpsを完璧に維持できた低速録画の生データは重複50%。閾値を換算しないと
    # 正常な録画が必ず「処理落ち」と判定されてリトライされてしまう。
    threshold = rc.duplicate_rate_threshold_for_raw(rc.MAX_DUPLICATE_RATE_DEFAULT, 2.0)
    assert 50.0 <= threshold


def test_duplicate_rate_threshold_still_catches_a_real_stutter():
    # 目標30fpsのはずが実際には15fpsしか出ていない生データは重複75%で、換算後の
    # 閾値(65%)を超えるので正しくリトライされる。
    threshold = rc.duplicate_rate_threshold_for_raw(rc.MAX_DUPLICATE_RATE_DEFAULT, 2.0)
    assert 75.0 > threshold


def test_prepare_instance_places_cfg_and_replay_into_the_appdata_profile(tmp_path, monkeypatch):
    """th20(th125以降のエンジン)はゲーム本体ディレクトリではなく%APPDATA%を読む。"""
    monkeypatch.setattr(rc.getpass, "getuser", lambda: "root")
    game_dir = tmp_path / "games" / "th20"
    game_dir.mkdir(parents=True)
    (game_dir / "th20.cfg").write_bytes(b"cfg")
    (game_dir / "th20.exe").write_bytes(b"exe")
    replay = tmp_path / "upload.rpy"
    replay.write_bytes(b"replay")
    injector = tmp_path / "injector.exe"
    injector.write_bytes(b"i")
    hook = tmp_path / "th20_hook.dll"
    hook.write_bytes(b"h")

    config = make_config(
        game_id="th20",
        wineprefix=str(tmp_path / "prefix"),
        instance_dir=str(tmp_path / "instance"),
        game_dir_src=str(game_dir),
        canonical_slot="th20_ud0000.rpy",
        injector_path=str(injector),
        hook_dll_path=str(hook),
        uses_appdata_profile=True,
    )
    (tmp_path / "instance").mkdir()

    rc.prepare_instance(config, str(replay), log=lambda _m: None)

    appdata = tmp_path / "prefix/drive_c/users/root/AppData/Roaming/ShanghaiAlice/th20"
    assert (appdata / "th20.cfg").read_bytes() == b"cfg"
    assert (appdata / "replay/th20_ud0000.rpy").read_bytes() == b"replay"


def test_prepare_instance_clears_stale_replays_from_the_appdata_profile(tmp_path, monkeypatch):
    """MODは常に一覧の1件目を選ぶので、前回のリプレイが残っていると別物を録画する。"""
    monkeypatch.setattr(rc.getpass, "getuser", lambda: "root")
    game_dir = tmp_path / "games" / "th20"
    (game_dir / "replay").mkdir(parents=True)
    (game_dir / "th20.cfg").write_bytes(b"cfg")
    appdata = tmp_path / "prefix/drive_c/users/root/AppData/Roaming/ShanghaiAlice/th20"
    (appdata / "replay").mkdir(parents=True)
    (appdata / "replay/th20_ud9999.rpy").write_bytes(b"stale")
    replay = tmp_path / "upload.rpy"
    replay.write_bytes(b"replay")
    injector = tmp_path / "injector.exe"
    injector.write_bytes(b"i")
    hook = tmp_path / "th20_hook.dll"
    hook.write_bytes(b"h")

    config = make_config(
        game_id="th20",
        wineprefix=str(tmp_path / "prefix"),
        instance_dir=str(tmp_path / "instance"),
        game_dir_src=str(game_dir),
        canonical_slot="th20_ud0000.rpy",
        injector_path=str(injector),
        hook_dll_path=str(hook),
        uses_appdata_profile=True,
    )
    (tmp_path / "instance").mkdir()

    rc.prepare_instance(config, str(replay), log=lambda _m: None)

    assert sorted(p.name for p in (appdata / "replay").iterdir()) == ["th20_ud0000.rpy"]


def test_prepare_instance_skips_the_appdata_profile_for_other_titles(tmp_path, monkeypatch):
    monkeypatch.setattr(rc.getpass, "getuser", lambda: "root")
    game_dir = tmp_path / "games" / "th11"
    game_dir.mkdir(parents=True)
    replay = tmp_path / "upload.rpy"
    replay.write_bytes(b"replay")
    injector = tmp_path / "injector.exe"
    injector.write_bytes(b"i")
    hook = tmp_path / "th11_hook.dll"
    hook.write_bytes(b"h")

    config = make_config(
        game_id="th11",
        wineprefix=str(tmp_path / "prefix"),
        instance_dir=str(tmp_path / "instance"),
        game_dir_src=str(game_dir),
        canonical_slot="th11_ud0000.rpy",
        injector_path=str(injector),
        hook_dll_path=str(hook),
    )
    (tmp_path / "instance").mkdir()

    rc.prepare_instance(config, str(replay), log=lambda _m: None)

    assert not (tmp_path / "prefix").exists()
