"""自宅マシンの余力判定(Issue #49 の論点4)。

判定は2段構え:

- `max_concurrency`: 同時録画数の上限。自宅マシンでは4並列まで処理落ちなく録画
  できることを確認済み(Issue #49)。
- ロードアベレージ: 上限に達していなくても、開発者が自宅マシンを別用途で使って
  いる最中に録画を引き受けて母艦を重くしないためのガード。

**新規claimを止めることと、実行中ジョブを止めることは別**である(Issue #49 の
論点4)。この関数群は前者にしか使わない。走り出した録画は最後まで完走させる
——中断すればそのジョブは丸ごとやり直しになり、節約したCPU時間よりはるかに
大きな無駄になるため。
"""
import os


def load_per_cpu(getloadavg=os.getloadavg, cpu_count=os.cpu_count):
    """1コアあたりの1分間ロードアベレージ。取得できない環境では0.0。"""
    try:
        load = getloadavg()[0]
    except OSError:
        return 0.0
    cpus = cpu_count() or 1
    return load / cpus


def can_accept(config, active_jobs, load=None):
    """新しいジョブをclaimしてよいか。"""
    if active_jobs >= config.max_concurrency:
        return False
    current = load_per_cpu() if load is None else load
    return current <= config.load_threshold
