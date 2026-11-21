#!/usr/bin/env python3
"""リプレイずれ(デシンク)の有無を、記録スコアと再生時スコアの突き合わせで判定する。

東方のリプレイファイルは末尾に平文の`USER`セクションを持っており、記録時の最終
スコア・難易度・到達ステージ等が入っている(本文は暗号化されているが、この
セクションだけは平文)。一方、再生側の実際のスコアは
`mods/common/score_monitor.*`(MODログの`ScoreMonitor:`行)から得られる。

両者が一致すれば「リプレイが記録時と同じ結果まで完走した = ずれていない」と
判定できる。ずれた場合は途中で被弾・取りこぼしが発生するため、ほぼ確実に
スコアが変わる。

usage:
  scripts/50_check_replay_desync.py <replay.rpy> <autoplay.log>
  scripts/50_check_replay_desync.py --json <replay.rpy> <autoplay.log>
"""
import argparse
import datetime
import json
import os
import re
import sys


def parse_replay_user_section(path):
    """リプレイファイル末尾の平文USERセクションを辞書として返す。"""
    with open(path, "rb") as f:
        data = f.read()
    # USERブロックの構造(th10系以降で共通):
    #   'USER' (4) + サイズ(u32, ヘッダ12バイトを含む) + 種別(u32) + 本体
    # 種別0がリプレイ情報テキスト(CRLF区切りの `キー 値`)、種別1がコメント。
    # ヘッダのオフセット0x0Cが最初のUSERブロック位置を指している。
    text = None
    pos = data.find(b"USER")
    while pos >= 0 and pos + 12 <= len(data):
        size = int.from_bytes(data[pos + 4:pos + 8], "little")
        kind = int.from_bytes(data[pos + 8:pos + 12], "little")
        if size < 12 or pos + size > len(data):
            break
        if kind == 0:
            text = data[pos + 12:pos + size].decode("cp932", errors="replace")
            break
        pos = data.find(b"USER", pos + size)
    if text is None:
        raise ValueError(f"USERセクション(種別0)が見つかりません: {path}")

    info = {}
    for line in text.split("\r\n"):
        line = line.strip("\x00 ")
        if not line or line == "USER":
            continue
        # "Slow Rate 0.03" のように キー名に空白を含むものがあるため、
        # 既知のキーを前方一致で拾う。
        for key in ("Version", "Name", "Date", "Chara", "Rank", "Stage",
                    "Score", "Slow Rate"):
            if line.startswith(key + " "):
                info[key] = line[len(key) + 1:].strip()
                break
    if "Score" not in info:
        raise ValueError(f"USERセクションにScoreがありません: {path}")
    info["Score"] = int(info["Score"])
    return info


SCORE_RE = re.compile(
    r"ScoreMonitor: score=(\d+) stage=(\d+) lives=(-?\d+) graze=(-?\d+) epoch_ms=(\d+)")


def parse_score_monitor(path):
    """MODログから ScoreMonitor のサンプル列を返す。"""
    samples = []
    with open(path, errors="replace") as f:
        for line in f:
            m = SCORE_RE.search(line)
            if m:
                samples.append({
                    "score": int(m.group(1)),
                    "stage": int(m.group(2)),
                    "lives": int(m.group(3)),
                    "graze": int(m.group(4)),
                    "epoch_ms": int(m.group(5)),
                })
    return samples


LOG_TS_RE = re.compile(r"^\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]")


def quiet_tail_seconds(path, last_sample_epoch_ms):
    """最後のScoreMonitorサンプルから、MODログが途切れるまでの秒数を返す。

    ScoreMonitorは値が変わったときだけ行を出すため、リプレイが終わって
    スコアが動かなくなると行が出なくなる。一方FpsMonitorはプロセスが
    kill されるまで5秒おきに出続けるので、両者の差が「スコアが動かなく
    なってから録画終了までの静止時間」になる。この時間が十分あれば
    「リプレイは終わっていた(打ち切りではない)」と判断できる。

    ログ行のタイムスタンプは時刻のみ(日付なし)なので、最後のサンプルの
    epoch から日付を復元する。
    """
    last_ts = None
    with open(path, errors="replace") as f:
        for line in f:
            m = LOG_TS_RE.match(line)
            if m:
                last_ts = tuple(int(g) for g in m.groups())
    if last_ts is None:
        return None

    sample_dt = datetime.datetime.fromtimestamp(last_sample_epoch_ms / 1000.0)
    log_dt = sample_dt.replace(hour=last_ts[0], minute=last_ts[1],
                               second=last_ts[2], microsecond=last_ts[3] * 1000)
    if log_dt < sample_dt:  # 日付をまたいだ場合
        log_dt += datetime.timedelta(days=1)
    return (log_dt - sample_dt).total_seconds()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("replay", help="リプレイファイル (.rpy)")
    parser.add_argument("log", help="MODのオートプレイログ (th20_autoplay.log)")
    parser.add_argument("--json", action="store_true", help="JSONで出力する")
    parser.add_argument("--record-log", default=None,
                        help="scripts/25の実行ログ。強制タイムアウトで打ち切られた録画を"
                             "デシンクと誤判定しないために使う")
    args = parser.parse_args()

    info = parse_replay_user_section(args.replay)
    samples = parse_score_monitor(args.log)

    if not samples:
        print("ERROR: ログに ScoreMonitor 行がありません "
              "(score_monitor 未組み込みのDLLで録画された可能性があります)",
              file=sys.stderr)
        sys.exit(2)

    final = samples[-1]
    peak = max(s["score"] for s in samples)
    expected = info["Score"]
    matched = final["score"] == expected

    # 「録画が途中で打ち切られただけ」をデシンクと取り違えないための判定材料。
    # th20_ud0000.rpy(Lunatic・スコアアタック、グレイズ過多で処理落ちが激しい)は
    # 既定の TIMEOUT_SEC(40分)ではクリア前に録画が終わり、スコアが記録値に
    # 届かないまま「不一致」になった実例がある(フェーズ50)。
    timed_out = False
    if args.record_log and os.path.exists(args.record_log):
        with open(args.record_log, errors="replace") as f:
            timed_out = "TIMEOUT:" in f.read()

    # スコアが動かなくなってから録画が終わるまでの静止時間。リプレイが最後まで
    # 再生されていれば、終了画面でスコアが止まったまま画面静止検知の待ち時間
    # (16秒)以上が経過するため、十分な長さになる。逆にほぼ0なら、スコアが
    # 動いている最中に録画が打ち切られたということ。
    quiet_tail = quiet_tail_seconds(args.log, final["epoch_ms"])
    QUIET_TAIL_MIN_SEC = 20.0
    cut_while_playing = quiet_tail is not None and quiet_tail < QUIET_TAIL_MIN_SEC
    truncated = timed_out or cut_while_playing

    # リプレイ再生中にスコアが動いた区間の実時間(参考値)
    playing = [s for s in samples if s["score"] > 0]
    play_sec = ((playing[-1]["epoch_ms"] - playing[0]["epoch_ms"]) / 1000.0
                if len(playing) >= 2 else 0.0)

    # 残機が負になった = ゲームオーバー。th20はデシンク後も残機0以下で強制終了せず
    # リプレイ再生を続行する仕様(AGENTS.md参照)なので、All Clearのリプレイで
    # これが起きていたら、録画が打ち切られていようとデシンクは確定している。
    # なお起動直後のstage=0の区間はlives=-1になることがあるため除外する。
    died_out = any(s["lives"] < 0 for s in samples if s["stage"] >= 1)
    all_clear = info.get("Stage", "").strip().lower().startswith("all clear")

    if matched:
        verdict = "match"
    elif died_out and all_clear:
        verdict = "desync"
    elif truncated:
        verdict = "truncated"
    else:
        verdict = "desync"

    result = {
        "replay": os.path.basename(args.replay),
        "expected_score": expected,
        "final_score": final["score"],
        "peak_score": peak,
        "score_matched": matched,
        "verdict": verdict,
        "timed_out": timed_out,
        "quiet_tail_sec": round(quiet_tail, 1) if quiet_tail is not None else None,
        "died_out": died_out,
        "final_stage": final["stage"],
        "final_lives": final["lives"],
        "final_graze": final["graze"],
        "replay_rank": info.get("Rank", "").strip(),
        "replay_stage": info.get("Stage", "").strip(),
        "replay_name": info.get("Name", "").strip(),
        "play_seconds": round(play_sec, 1),
        "samples": len(samples),
    }

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"リプレイ      : {result['replay']} "
              f"({result['replay_rank']} / {result['replay_stage']} / {result['replay_name']})")
        print(f"記録時スコア  : {expected:,}")
        print(f"再生時スコア  : {final['score']:,} (最大 {peak:,})")
        print(f"到達ステージ  : {result['final_stage']}  残機: {result['final_lives']}  "
              f"グレイズ: {result['final_graze']:,}")
        print(f"スコア動作時間: {play_sec:.1f}s  サンプル数: {len(samples)}")
        if died_out:
            print("警告          : 再生中に残機が負になっています(ゲームオーバー)")
        verdict_text = {
            "match": "一致(デシンクなし)",
            "desync": "不一致(デシンク)" if died_out else "不一致(デシンクの疑い)",
            "truncated": "判定不能(リプレイ完走前に録画が打ち切られている"
                         f"{' / TIMEOUT検知' if timed_out else ''}"
                         f"{f' / スコア変動中に録画終了(静止{quiet_tail:.0f}s)' if cut_while_playing else ''})",
        }[verdict]
        print(f"判定          : {verdict_text}")

    sys.exit({"match": 0, "desync": 1, "truncated": 3}[verdict])


if __name__ == "__main__":
    main()
