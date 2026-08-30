"""`recording` パッケージのテストが共有するヘルパ。

pytest のフィクスチャではなく素の関数なので、各テストファイルから明示的に import する
(tests/ 直下は pytest が sys.path へ入れる)。
"""
import subprocess

from recording.config import GameConfig


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
    return GameConfig(**kwargs)


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
