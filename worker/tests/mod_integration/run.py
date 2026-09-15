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

sys.path.insert(0, str(WORKER_ROOT))
from recording.modlog import SCORE_MONITOR_RE, GRAZE_GARBAGE_MAX  # noqa: E402

# ScoreMonitorは1秒間隔のポーリングでしか値を見ていないため、被弾タイミングの
# 観測誤差は原理的に最大1秒強ある。基準値(expected_hit_offsets_seconds)との
# 比較はこの誤差を吸収できる余裕を持たせる。
HIT_TIMING_TOLERANCE_SECONDS = 3.0

# 各タイトルの検証リプレイと期待値。expected_score はリプレイファイルに記録された
# 最終スコア(画面表示値、threp -j で確認できる)。リプレイを差し替えたら要更新。
# th09は最終スコアがリプレイに記録されない(score_monitorもscoreWidth=0でスコア
# 未監視、docs/mods.md §3)ため expected_score=None とし、--expected-score 自体を
# 渡さない(entrypoint.pyがEXPECTED_SCORE未設定時に同じ挙動をするのに合わせてある)。
# display は record_th{game}.py の GameConfig.for_game(display=...) と同じ値を書く
# (残留プロセスの掃除に使う。2箇所の値がずれると掃除対象を取り違えるので、
# record_thNN.py側のdisplayを変更したらここも合わせること)。th08とth10は
# record_thNN.py側で偶然どちらも:98を使っているが、このスクリプトはタイトルを
# 逐次実行するため同時に使われることはなく問題ない。
# expected_hit_offsets_seconds は、残機(lives)のRVAが判明しているタイトルにのみ
# 存在するキー(未特定のth06c/th06ncには無い、docs/mods.md §3)。この検証リプレイを
# 1度実機録画し、ScoreMonitorログ上で残機が減少した時点の、最初のサンプルからの
# 経過秒数を`read_lives_drop_offsets()`で観測した基準値(2026-09-15、HakataMatrix)。
# リプレイを差し替えたら実機録画して採り直すこと。
TITLES = {
    "th06": {
        "replay": "th6_10.rpy",
        "expected_score": 13_951_380,
        "expected_duration_seconds": 6924 / 60,
        "display": ":96",
        "expected_hit_offsets_seconds": [84.1, 121.1],
    },
    "th06c": {
        "replay": "th6_09.rpy",
        "expected_score": 13_004_650,
        "expected_duration_seconds": 7668 / 60,
        "display": ":102",
    },
    "th06nc": {
        "replay": "th6_31.rpy",
        "expected_score": 25_890_400,
        "expected_duration_seconds": 7601 / 60,
        "display": ":103",
    },
    "th07": {
        "replay": "th7_12.rpy",
        "expected_score": 3_581_800,
        "expected_duration_seconds": 7292 / 60,
        "display": ":97",
        "expected_hit_offsets_seconds": [109.1, 115.1],
    },
    "th08": {
        "replay": "th8_06.rpy",
        "expected_score": 59_889_420,
        "expected_duration_seconds": 8373 / 60,
        "display": ":98",
        "expected_hit_offsets_seconds": [127.1, 133.1],
    },
    "th09": {
        "replay": "th9_25.rpy",
        "expected_score": None,
        "expected_duration_seconds": 6566 / 60,
        "display": ":101",
        "expected_hit_offsets_seconds": [88.1, 97.1],
    },
    "th10": {
        "replay": "th10_01.rpy",
        "expected_score": 15_400_100,
        "expected_duration_seconds": 7361 / 60,
        "display": ":98",
        "expected_hit_offsets_seconds": [123.1, 129.1, 135.1],
    },
    "th11": {
        "replay": "th11_06.rpy",
        "expected_score": 63_738_500,
        "expected_duration_seconds": 7344 / 60,
        "display": ":99",
        "expected_hit_offsets_seconds": [123.1, 129.1, 134.1],
    },
    "th12": {
        "replay": "th12_02.rpy",
        "expected_score": 31_221_250,
        "expected_duration_seconds": 7875 / 60,
        "display": ":100",
        "expected_hit_offsets_seconds": [129.1, 138.1, 143.1],
    },
    "th20": {
        "replay": "th20_08.rpy",
        "expected_score": 9_243_950,
        "expected_duration_seconds": 6722 / 60,
        "display": ":95",
        "expected_hit_offsets_seconds": [122.1, 127.1, 133.2],
    },
}


def instance_log_path(game):
    """record_{game}.pyが書き込むMODログの実パス(`recording.config.GameConfig`の
    `log_path`と同じ導出)。SATTORI_INSTANCE_DIRを上書きしていない前提。"""
    return WORKER_ROOT / "instances" / f"{game}-recording" / f"{game}_autoplay.log"


def read_lives_drop_offsets(log_path):
    """ScoreMonitorログ(1秒間隔ポーリング)から、残機(lives)が減少した各時点の、
    最初のサンプルからの経過秒数をリストで返す(サンプルが1つも無ければ空)。

    このMOD統合テストの検証リプレイは共通して「無被弾で中ボスまで進行 → ボム
    使用 → わざと数回被弾してゲームオーバー」という型なので(README参照)、
    残機の減少イベントがそのまま被弾タイミングの実測値になる。ボム使用中は
    無敵で残機が減らないため、ボム使用そのものはこの方法では検出できない
    (残機・スコア以外にボム数を読むRVAはどのタイトルも未特定)。

    起動直後の数秒はゲーム状態構造体が未初期化のまま読んでしまい、残機が
    ゴミ値(例: th20実機でstage=0のまま一瞬lives=-1になる、2026-09-15観測)に
    なることがある。このテストの検証リプレイはいずれも最短でも被弾まで80秒
    以上あるため、起動直後`STARTUP_GRACE_SECONDS`はベースライン確立用として
    読み捨てて誤検知を防ぐ。
    """
    STARTUP_GRACE_SECONDS = 5.0
    if not os.path.exists(log_path):
        return []
    samples = []
    with open(log_path) as f:
        text = f.read()
    for m in SCORE_MONITOR_RE.finditer(text):
        lives, graze = int(m.group(3)), int(m.group(4))
        if graze < 0 or graze > GRAZE_GARBAGE_MAX:
            continue
        samples.append((int(m.group(5)), lives))
    if not samples:
        return []
    t0 = samples[0][0]
    offsets = []
    prev_lives = samples[0][1]
    for epoch_ms, lives in samples[1:]:
        elapsed = (epoch_ms - t0) / 1000
        # prev_livesは猶予期間中も更新し続ける(起動直後のゴミ値からの回復を
        # 正しい残機へのベースライン更新として扱う)。offsetsへの記録だけを
        # 猶予期間終了後に限定する。
        if lives < prev_lives and elapsed >= STARTUP_GRACE_SECONDS:
            offsets.append(round(elapsed, 1))
        prev_lives = lives
    return offsets


def check_hit_timing(game, cfg):
    """被弾タイミングの実測値が、このリプレイを一度実機録画して観測した基準値
    (`expected_hit_offsets_seconds`)から大きくずれていないかを確認する。

    `expected_hit_offsets_seconds`を持たないタイトル(残機RVA未特定、README・
    docs/mods.md §3参照)ではNoneを返し、run_one()側は検証スキップとして扱う。
    """
    if "expected_hit_offsets_seconds" not in cfg:
        return None
    expected = cfg["expected_hit_offsets_seconds"]
    actual = read_lives_drop_offsets(instance_log_path(game))
    if not actual:
        print(f"[{game}] WARNING: 被弾タイミング検証ができませんでした(MODログから残機の変化が取得できなかった)")
        return None
    if len(actual) != len(expected):
        print(
            f"[{game}] NG: 被弾回数が基準値と異なります(基準{len(expected)}回{expected}、"
            f"実測{len(actual)}回{actual})",
        )
        return True
    max_diff = max(abs(a - e) for a, e in zip(actual, expected))
    if max_diff > HIT_TIMING_TOLERANCE_SECONDS:
        print(
            f"[{game}] NG: 被弾タイミングが基準値から{max_diff:.1f}秒ずれています"
            f"(基準{expected}、実測{actual})",
        )
        return True
    print(f"[{game}] OK: 被弾タイミングは基準値と一致しました(実測{actual}、基準{expected})")
    return False


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


def cleanup_stale_display(display, log_prefix):
    """`display`(例: ":96")に残っている前回試行のXvfbを検知し、あれば強制終了する。

    このスクリプトは`timeout --kill-after=`で打ち切るため、前回の試行がタイムアウトで
    SIGKILLされるとrecord_{game}.py側の後片付け(Xvfb終了)がfinally節ごと吹き飛び、
    Xvfbだけプロセスとして残り続ける。残ったままだと次回試行の`grab_frame()`
    (`recording/vision.py`、pollごとに新しいffmpegでそのdisplayをx11grabする)が
    ブロックし続け、終了検知のpollログが1行も出ないまま必ず330秒タイムアウトで
    失敗する(2026-09-15、th06/th08で実際に観測・re-run で再現確認済み)。
    `check_home_worker_idle()`でデーモン停止を確認済みの前提のため、このdisplayに
    残っているXvfbは前回試行の残骸とみなしてよい。
    """
    result = subprocess.run(
        ["pgrep", "-f", f"Xvfb {display} "], capture_output=True, text=True, check=False,
    )
    pids = [pid for pid in result.stdout.split() if pid]
    if not pids:
        return
    print(
        f"{log_prefix} WARNING: display {display} に前回試行の残留Xvfbを検出したため終了します"
        f"(pid={','.join(pids)})",
    )
    subprocess.run(["kill", "-9", *pids], check=False)


def run_one(game, keep_output):
    cfg = TITLES[game]
    cleanup_stale_display(cfg["display"], f"[{game}]")
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
            "--desync-result-path", str(desync_result),
            "--timeout-result-path", str(timeout_result),
            "--max-attempts", "1",
        ]
        if cfg["expected_score"] is not None:
            cmd += ["--expected-score", str(cfg["expected_score"])]
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

        if ok and check_hit_timing(game, cfg):
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
