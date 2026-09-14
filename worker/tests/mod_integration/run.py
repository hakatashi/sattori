#!/usr/bin/env python3
"""MOD(worker/mods/)の退行検知テスト。

決まった短いリプレイ(../fixtures/mod-integration/)を、ホストにセットアップ済みの
`worker/games/`・`worker/prefixes/`・`worker/mods/`(ビルド成果物)を使って実際に録画し、
以下が起きないことを自動判定する:

- record_thNN.py の異常終了(exit code != 0。重複フレーム率が閾値を超え続けた場合を含む)
- リプレイずれ(デシンク)の疑いの検知(recording.modlog.check_replay_desync())
- 終了検知に失敗したことによるタイムアウト打ち切り

**`worker/games/<game>/`・`worker/prefixes/<game>-wined3d-gl/`にゲーム本体・WINEPREFIXが
展開済みの環境専用**(`docs/runbooks/worker-local-recording.md` §2のホスト直接実行と同じ
経路。Wine・Xvfb・PulseAudioがホストにインストール済みであることが前提)。ゲーム資産の
ライセンス上CIでは実行できないため、push毎には実行しない。MOD(*_hook.dll)のソースを
変更した後、実機検証の前段の速い足がかりとして手動で実行する。`build-mods` skillで
再ビルドしてから使うこと(`worker/mods/*/build/`のビルド成果物をそのまま参照する)。

使い方:
    python3 worker/tests/mod_integration/run.py               # 対象タイトル全部
    python3 worker/tests/mod_integration/run.py --game th06   # th06のみ
    python3 worker/tests/mod_integration/run.py --keep-output # 失敗時に出力を残す

事前条件:
- `worker/games/<game>/`・`worker/prefixes/<game>-wined3d-gl/`にゲーム資産・WINEPREFIXが
  展開済みであること(`setup_wineprefix.sh`、`upload-title-assets` skill参照)
- 同一ホストで sattori-home-worker(自宅ワーカーデーモン)が稼働している場合は、Xvfbの
  ディスプレイ番号・PulseAudioの競合を避けるため停止していること
- ホスト直接実行はWineプロセス残留によるハングのリスクを伴うため(§2参照)、本スクリプトは
  `timeout --kill-after=` を必ず併用する
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

WORKER_ROOT = Path(__file__).resolve().parents[2]
FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures" / "mod-integration"
RECORD_TIMEOUT_SECONDS = 300  # フル尺が2分強のリプレイなので、余裕を見て5分で打ち切る

# 各タイトルの検証リプレイと期待値。expected_score はリプレイファイルに記録された
# 最終スコア(画面表示値、threp -j で確認できる)。リプレイを差し替えたら要更新。
TITLES = {
    "th06": {
        "replay": "th6_10.rpy",
        "expected_score": 13_951_380,
        "expected_duration_seconds": 6924 / 60,
    },
    "th08": {
        "replay": "th8_05.rpy",
        "expected_score": 30_082_870,
        "expected_duration_seconds": 7569 / 60,
    },
}


def check_home_worker_idle():
    """sattori-home-worker(自宅ワーカーデーモン)が同一ホストで稼働中なら中断する。

    このユニットが存在しない環境(自宅ワーカー機以外でworker/gamesをセットアップした
    場合)では、このチェック自体が意味を持たないためスキップする。
    """
    try:
        result = subprocess.run(
            ["systemctl", "is-active", "sattori-home-worker"],
            capture_output=True, text=True, check=False,
        )
    except FileNotFoundError:
        return
    status = result.stdout.strip() or result.stderr.strip()
    if status in ("inactive", "unknown"):
        return
    print(
        f"ERROR: sattori-home-worker が停止していません(状態: {status})。\n"
        "Xvfbのディスプレイ番号・PulseAudioの競合を避けるため、稼働中は実行できません。"
        "停止してよいか確認してから再実行してください。",
        file=sys.stderr,
    )
    sys.exit(1)


def run_one(game, keep_output):
    cfg = TITLES[game]
    replay_path = FIXTURES_DIR / game / cfg["replay"]
    if not replay_path.exists():
        print(f"[{game}] ERROR: {replay_path} が見つかりません", file=sys.stderr)
        return False

    game_dir = WORKER_ROOT / "games" / game
    prefix_dir = WORKER_ROOT / "prefixes" / f"{game}-wined3d-gl"
    if not game_dir.is_dir() or not prefix_dir.is_dir():
        print(
            f"[{game}] ERROR: {game_dir} または {prefix_dir} が見つかりません。"
            "setup_wineprefix.sh・upload-title-assets skillの手順でこの環境に"
            "ゲーム資産を用意してください。",
            file=sys.stderr,
        )
        return False

    tmp_root = Path(tempfile.mkdtemp(prefix=f"sattori-mod-integration-{game}-"))
    try:
        output_path = tmp_root / "repro.mp4"
        desync_result = tmp_root / "desync.json"
        timeout_result = tmp_root / "timeout.json"

        cmd = [
            "timeout", "--kill-after=30s", str(RECORD_TIMEOUT_SECONDS + 30),
            "python3", f"record_{game}.py",
            "--replay-path", str(replay_path),
            "--output", str(output_path),
            "--diagnostics-dir", str(tmp_root / "diagnostics"),
            "--progress-dir", str(tmp_root / "progress"),
            "--expected-duration-seconds", str(cfg["expected_duration_seconds"]),
            "--expected-score", str(cfg["expected_score"]),
            "--desync-result-path", str(desync_result),
            "--timeout-result-path", str(timeout_result),
            "--max-attempts", "1",
        ]
        print(f"[{game}] 録画開始(worker/games/{game}, worker/prefixes/{game}-wined3d-gl を使用)...")
        t0 = time.time()
        run_log = tmp_root / "run.log"
        with open(run_log, "w") as f:
            proc = subprocess.run(cmd, cwd=WORKER_ROOT, stdout=f, stderr=subprocess.STDOUT, check=False)
        elapsed = time.time() - t0
        print(f"[{game}] 終了(exit={proc.returncode}, {elapsed:.0f}s)")

        ok = proc.returncode == 0
        if not ok:
            print(f"[{game}] NG: record_{game}.py が異常終了しました(ログ: {run_log if keep_output else '破棄'})")

        # write_desync_result()/write_timeout_result()(recording/artifacts.py)は
        # {"desyncDetected": bool|None}/{"timedOut": bool}というオブジェクトを書き出す。
        # 値そのものではなくオブジェクトの真偽値を見ると常にtruthyになる罠があるので注意。
        desync = json.loads(desync_result.read_text())["desyncDetected"] if desync_result.exists() else None
        if desync:
            print(f"[{game}] NG: リプレイずれ(デシンク)の疑いが検知されました")
            ok = False
        elif desync is None and ok:
            print(f"[{game}] WARNING: デシンク検証ができませんでした(MODログからスコアが取得できなかった)")

        timed_out = json.loads(timeout_result.read_text())["timedOut"] if timeout_result.exists() else None
        if timed_out:
            print(f"[{game}] NG: リプレイ終了を検知できずタイムアウトで打ち切られました")
            ok = False

        if keep_output or not ok:
            dest = Path(tempfile.gettempdir()) / f"sattori-mod-integration-{game}-result"
            if dest.exists():
                shutil.rmtree(dest)
            shutil.copytree(tmp_root, dest)
            print(f"[{game}] 出力を保存しました: {dest}")

        return ok
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--game", nargs="*", choices=sorted(TITLES), default=sorted(TITLES))
    parser.add_argument("--keep-output", action="store_true", help="成功時も録画結果・ログを/tmpに残す")
    args = parser.parse_args()

    check_home_worker_idle()

    results = {game: run_one(game, args.keep_output) for game in args.game}

    print("\n=== 結果 ===")
    for game, ok in results.items():
        print(f"{game}: {'OK' if ok else 'NG'}")
    sys.exit(0 if all(results.values()) else 1)


if __name__ == "__main__":
    main()
