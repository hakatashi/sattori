#!/usr/bin/env python3
"""ステージ開始検出手段の調査用ランナー(フェーズ49)。

`recorder` パッケージのセットアップ処理(Xvfb起動・
instanceディレクトリ準備・injector起動・後始末)だけを再利用して、録画は行わずに
STAGE_PROBE有効のMODでリプレイを一定時間再生し、MODログを収集する。

録画を伴わないのは、(1) 調査に必要なのはMODログだけであること、(2) メモリ
差分スキャンのCPU負荷が録画品質(重複フレーム率)に影響しうるため、検出手段の
洗い出し段階では録画と切り離したいこと、による。

使い方:
    python3 scripts/49_stage_probe_run.py --game th07 --replay th7_09.rpy --duration 540
"""

import argparse
import os
import subprocess
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

from recorder import game_ids, load_game_config, log  # noqa: E402
from recorder.instance import (  # noqa: E402
    build_injector_cmd,
    ensure_display,
    prepare_instance,
)
from recorder.process import find_live_game_pid, kill_wine_and_wait  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", required=True, choices=sorted(game_ids()))
    ap.add_argument("--replay", default=None)
    ap.add_argument("--duration", type=float, default=540.0, help="再生させる秒数")
    ap.add_argument("--out", default=None, help="MODログのコピー先")
    args = ap.parse_args()

    config = load_game_config(args.game)
    replay = args.replay or config.default_replay

    env = config.build_env()
    for key in (
        "STAGE_PROBE", "STAGE_PROBE_IO", "STAGE_PROBE_MEM", "STAGE_PROBE_SCAN_MB",
        "STAGE_PROBE_INTERVAL_MS", "STAGE_PROBE_MAX_CHANGES", "STAGE_PROBE_MAX_VALUE",
        "STAGE_PROBE_WARMUP_SEC", "STAGE_PROBE_STRICT",
    ):
        if key in os.environ:
            env[key] = os.environ[key]
    env.setdefault("STAGE_PROBE", "1")

    ensure_display(config, env)
    kill_wine_and_wait(config, env)
    prepare_instance(config, replay)

    cmd, dll_args = build_injector_cmd(config)
    log(f"injector を起動します (dlls={dll_args}, STAGE_PROBE={env['STAGE_PROBE']})")
    t_launch = time.time()
    subprocess.Popen(
        cmd, cwd=config.instance_dir, env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    game_pid = None
    while time.time() - t_launch < 30:
        game_pid = find_live_game_pid(config)
        if game_pid:
            break
        time.sleep(0.1)
    if not game_pid:
        log("ERROR: ゲームプロセスが検出できませんでした")
        sys.exit(1)
    log(f"game_pid={game_pid} 起動から{time.time()-t_launch:.1f}s")

    deadline = time.time() + args.duration
    while time.time() < deadline:
        time.sleep(10)
        if find_live_game_pid(config) is None:
            log("ゲームプロセスが終了しました")
            break
        log(f"経過 {time.time()-t_launch:.0f}s / {args.duration:.0f}s")

    out = args.out or f"{REPO}/runs/th_stage_probe/{args.game}_probe.log"
    os.makedirs(os.path.dirname(out), exist_ok=True)
    if os.path.exists(config.log_path):
        subprocess.run(["cp", config.log_path, out], check=True)
        log(f"MODログを {out} にコピーしました "
            f"({os.path.getsize(out)/1024/1024:.1f} MiB)")
    else:
        log("WARNING: MODログが見つかりませんでした")

    kill_wine_and_wait(config, env)
    log("完了")


if __name__ == "__main__":
    main()
