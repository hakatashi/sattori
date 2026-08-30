"""ジョブごとの専用 PulseAudio null-sink の作成・破棄(Issue #48)。

同一ホストで複数ジョブを並列録画すると、全ジョブの音声が混ざって記録される問題が
あった。映像は Xvfb のディスプレイ番号で既に分離されているが、音声は全ジョブが
PulseAudio のデフォルト sink(`module-always-sink` が自動生成する `auto_null`)を
暗黙に共有しており、どのジョブの録音も他ジョブの音を拾ってしまうためである
(touhou-recorder reports/41)。

原因は PulseAudio・Wine いずれの構造的制約でもなく「全ジョブが同じ sink を指して
いること」だけなので、ジョブごとに専用の null-sink を作り、

  - ゲーム(Wine)側は環境変数 `PULSE_SINK` で出力先をその sink に固定する
    (`recording.config.GameConfig.build_env()`)
  - 録音側 ffmpeg はその sink の monitor(`<sink名>.monitor`)を入力にする
    (`recording.config.GameConfig.pulse_source`)

とすれば分離できる。reports/41 では疑似音源4並列(FFTで他ジョブの周波数が混入しない
ことを確認)と実ゲーム2並列(片方を SIGSTOP すると対応する sink の録音だけが -91dB
まで落ちる対照実験)で実証済み。

`auto_null` には依存しない。`module-always-sink` は「他に sink が1つも無い場合にのみ
`auto_null` を維持する」仕様のため、専用 sink をロードした時点で `auto_null` は消える
が、専用 sink しか使わない以上これは無害である(reports/41 §2)。

EC2 Fleet(1インスタンス=1ジョブ)でも同じ経路を通す。1ジョブしかない環境で専用 sink を
使うこと自体に副作用はなく、コードパスを一本化した方がテスト・保守が容易なため
(Issue #48 の実装方針6)。
"""
import os
import re
import subprocess
from contextlib import contextmanager

# sink 名の接頭辞。ジョブ由来の sink であることを識別できるようにしておく。
SINK_NAME_PREFIX = "sattori_job_"

# PulseAudio の sink 名として安全な文字(英数字・アンダースコア)以外を潰す。jobId の
# 生成規則(現状は UUID)に依存しないようにするため、呼び出し側は必ず
# sink_name_for_job() を通すこと(Issue #48 の実装方針5)。
_UNSAFE_CHARS_RE = re.compile(r"[^A-Za-z0-9_]")

# 正規化後に残す最大長。UUID(36文字)なら接頭辞込みで48文字に収まるため通常は効かないが、
# 将来 jobId が長くなった場合に sink 名が際限なく伸びないようにするための上限。
MAX_SINK_NAME_LENGTH = 60


def sink_name_for_job(job_id):
    """jobId から PulseAudio の sink 名を作る。"""
    return (SINK_NAME_PREFIX + _UNSAFE_CHARS_RE.sub("_", str(job_id)))[:MAX_SINK_NAME_LENGTH]


def local_sink_name():
    """record_th*.py をローカルで単体実行する場合の sink 名(jobId が無いときの既定値)。

    同一マシンで複数の録画スクリプトを手動で並列実行した場合も衝突しないよう、
    プロセスIDを使う。
    """
    return sink_name_for_job(f"local_{os.getpid()}")


def _pactl(args):
    return subprocess.run(["pactl", *args], capture_output=True, text=True)


def find_null_sink_modules(sink_name):
    """指定した sink 名で読み込まれている module-null-sink のモジュールIDを列挙する。

    `pactl list short modules` の出力(タブ区切り: ID / モジュール名 / 引数 / ...)を
    パースする。取得に失敗した場合は空リストを返す。
    """
    result = _pactl(["list", "short", "modules"])
    if result.returncode != 0:
        return []
    pattern = re.compile(rf"(?:^|\s){re.escape(f'sink_name={sink_name}')}(?:\s|$)")
    module_ids = []
    for line in result.stdout.splitlines():
        fields = line.split("\t")
        if len(fields) < 3 or fields[1] != "module-null-sink":
            continue
        if pattern.search(fields[2]):
            module_ids.append(fields[0].strip())
    return module_ids


def unload_module(module_id, log=print):
    """モジュールを unload する。成否を bool で返す(失敗してもログのみで例外は投げない)。"""
    result = _pactl(["unload-module", str(module_id)])
    if result.returncode != 0:
        log(f"WARNING: PulseAudioモジュール{module_id}のunloadに失敗しました: {result.stderr.strip()}")
        return False
    return True


def remove_sink(sink_name, log=print):
    """指定した sink 名の null-sink をすべて unload する(存在しなければ何もしない)。

    ジョブがクラッシュして sink が残ったまま同じジョブが再実行された場合、同名の sink が
    既に存在すると PulseAudio が新しい sink を `<名前>.2` にリネームしてしまい、
    `<名前>.monitor` からの録音が意図しない(前回の孤児)sink を指してしまう。これを
    避けるため、作成前に必ず同名の残骸を掃除する。

    掃除の対象を「同じ sink 名」に限定しているのは、並列録画時に他ジョブが使用中の
    sink を巻き込んで消さないため(`sattori_job_*` を一括削除すると、同一ホストで
    走っている他ジョブの音声が即座に壊れる)。
    """
    for module_id in find_null_sink_modules(sink_name):
        log(f"既存の同名sink({sink_name}, module={module_id})が残っていたためunloadします")
        unload_module(module_id, log=log)


def create_null_sink(sink_name, log=print):
    """ジョブ専用の null-sink を作成し、そのモジュールIDを返す。

    作成に失敗した場合は RuntimeError を投げる。sink が無ければ録音側 ffmpeg が
    `<sink名>.monitor` を開けずに即失敗し、どのみち録画は成立しないため、
    ここで明示的に失敗させて原因をログに残す。
    """
    remove_sink(sink_name, log=log)
    result = _pactl([
        "load-module", "module-null-sink",
        f"sink_name={sink_name}",
        f"sink_properties=device.description={sink_name}",
    ])
    if result.returncode != 0:
        raise RuntimeError(
            f"PulseAudioの専用sink({sink_name})を作成できませんでした: {result.stderr.strip()}"
        )
    module_id = result.stdout.strip()
    log(f"専用sinkを作成しました: {sink_name} (module={module_id})")
    return module_id


@contextmanager
def job_sink(sink_name, log=print):
    """ジョブ専用 null-sink を作成し、ブロックを抜けるときに(成功・失敗を問わず)unload する。"""
    module_id = create_null_sink(sink_name, log=log)
    try:
        yield sink_name
    finally:
        log(f"専用sinkを破棄します: {sink_name} (module={module_id})")
        unload_module(module_id, log=log)
