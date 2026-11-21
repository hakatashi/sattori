#!/usr/bin/env python3
"""ゲームプロセスのスレッド別CPU使用率を一定間隔で記録する(reports/99)。

使い方: scripts/99_thread_sampler.py <exe名(例 th15.exe)> <出力.tsv> [間隔秒]

プロセスが現れるまで待ち、消えたら終了する。各行は
  経過秒  スレッドID  comm  CPU%(その間隔での1コア比)
で、`99_summarize_threads.py`で集計する。perfはperf_event_paranoid=4で使えないため
/procのutime+stimeの差分で測る。
"""
import os
import sys
import time

exe, out = sys.argv[1], sys.argv[2]
interval = float(sys.argv[3]) if len(sys.argv) > 3 else 2.0
hz = os.sysconf("SC_CLK_TCK")


def find_pid():
    for e in os.listdir("/proc"):
        if not e.isdigit():
            continue
        try:
            with open(f"/proc/{e}/cmdline", "rb") as f:
                args = f.read().split(b"\0")
        except OSError:
            continue
        # Wine上のプロセスはargv[0]がWindowsパス(Z:\...\th15.exe)になる
        if args and args[0].lower().replace(b"\\", b"/").endswith(b"/" + exe.lower().encode()):
            return int(e)
    return None


def snap(pid):
    d = {}
    for t in os.listdir(f"/proc/{pid}/task"):
        try:
            with open(f"/proc/{pid}/task/{t}/stat") as f:
                s = f.read()
            with open(f"/proc/{pid}/task/{t}/comm") as f:
                comm = f.read().strip()
        except OSError:
            continue
        rest = s[s.rindex(")") + 2:].split()
        d[int(t)] = (comm, int(rest[11]) + int(rest[12]))
    return d


def sysstat():
    with open("/proc/stat") as f:
        v = [int(x) for x in f.readline().split()[1:]]
    return v[3] + v[4], sum(v)  # idle+iowait, 合計


pid = None
while pid is None:
    pid = find_pid()
    if pid is None:
        time.sleep(1)
t0 = time.time()
prev = snap(pid)
sprev = sysstat()
ncpu = os.cpu_count()
with open(out, "w") as f:
    f.write(f"# pid={pid} t0_epoch={t0:.3f}\n")
    while os.path.exists(f"/proc/{pid}"):
        time.sleep(interval)
        try:
            cur = snap(pid)
        except OSError:
            break
        el = time.time() - t0
        scur = sysstat()
        idle, tot = scur[0] - sprev[0], scur[1] - sprev[1]
        sprev = scur
        if tot:
            # 行の形式を揃えるため、システム全体の使用率を「comm=__system__」の行として出す(全CPU合計の%)
            f.write(f"{el:.1f}\t0\t__system__\t{(1 - idle / tot) * ncpu * 100:.1f}\n")
        for tid, (comm, ticks) in cur.items():
            p = prev.get(tid, (comm, ticks))[1]
            pct = (ticks - p) / hz / interval * 100
            if pct > 0.5:
                f.write(f"{el:.1f}\t{tid}\t{comm}\t{pct:.1f}\n")
        f.flush()
        prev = cur
