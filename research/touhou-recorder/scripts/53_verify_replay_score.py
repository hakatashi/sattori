#!/usr/bin/env python3
"""リプレイ再生が最後まで記録時と同じ結果で完走したかを、スコアの一致で判定する。

フェーズ50でth20向けに作った`scripts/50_check_replay_desync.py`を、フェーズ53で
th06/07/08/11/20全タイトルに一般化したもの。

やっていることは同じ: MODログの`ScoreMonitor:`行から再生終了時点のゲーム内
スコアを取り、リプレイファイルに記録された最終スコアと突き合わせる。一致すれば
「最後までズレずに(デシンクせず)再生できた」と言い切れる。

th20専用だったscripts/50との違い:

- リプレイファイルの記録スコア取得に、th06〜th20を統一的にカバーする
  `@sattori/touhou-replay-parser`(`scripts/53_get_replay_score.mjs`)を使う。
  scripts/50はth10以降専用の自前USERセクションパーサだったため、th06/07/08の
  古い平文ヘッダ形式には対応できなかった
- MODが常にログ出力する値は「ゲーム内部の生値」だが、
  @sattori/touhou-replay-parserの`score`は「画面表示値」を返す。両者の関係は
  タイトル世代で異なる(th06/th08は等倍、th07/th11/th20は内部値の10倍が
  表示値)ため、GAME_MULTIPLIERSで補正してから比較する
  (mods/common/score_monitor.hのコメント、および各dllmain.cppのコメント参照)
- 「cleared」判定にリプレイファイル側のstage文字列のパターンマッチではなく、
  @sattori/touhou-replay-parserが構造化して返す`cleared`真偽値をそのまま使う

usage:
  scripts/53_verify_replay_score.py --game th07 <replay.rpy> <autoplay.log>
  scripts/53_verify_replay_score.py --game th20 --json <replay.rpy> <autoplay.log> --record-log <record.log>
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ゲーム内部の生値(MODがログ出力する値)に掛けると、
# @sattori/touhou-replay-parserの`score`(画面表示値)と一致する係数。
# th07/th08/th11/th20はフル尺録画での最終値完全一致により実証済み
# (reports/53_phase53_score_monitor_all_titles.md)。th08は当初「等倍」と
# 推測していたが、実機検証の結果th07/th11/th20と同じ×10が正解だった
# (thprac側の「real_score = thPracParam.score / 10」というコメントの
# 解釈を誤っていた)。th06は短時間録画でのオーダー確認のみ(等倍と推測)。
GAME_MULTIPLIERS = {
    "th06": 1,
    "th07": 10,
    "th08": 10,
    "th11": 10,
    "th20": 10,
    # th10: thprac(thprac_th10.cpp)の`*(int32_t*)(0x474c44) = score / 10`という
    # 書き込みコードから×10系列と推測(フェーズ56)。フル尺録画での完全一致検証は未実施。
    "th10": 10,
    # th12: フェーズ61でフル尺録画(th12_02.rpy)での最終値完全一致
    # (内部値18,324,071 x 10 = 183,240,710 = リプレイ記録スコア)により実証済み。
    "th12": 10,
    # th128: フェーズ70で短時間録画中のHUD表示値(いまスコア52,710)と内部値
    # (score=5271)の完全一致(x10)を実機確認済み。フル尺録画での最終値
    # 一致検証はフェーズ70で追加実施。
    "th128": 10,
    # th06c: オリジナルth06と同じく内部値=表示値(等倍)。フェーズ74で、
    # スコア変数のRVA(module+0x003A3B4C)を全メモリ探索で特定した上で、
    # th6_05.rpy(Normal、記録スコア1,126,970)の再生終了時の内部値が
    # 記録スコアと完全一致することを実機確認済み。
    "th06c": 1,
    # th06nc: th06c同様、内部値=表示値(等倍)。フェーズ79でスコア変数のRVA
    # (module+0x004F2790)を全メモリ探索で特定した。
    "th06nc": 1,
    "th13": 10,
    "th14": 10,
    "th15": 10,
}

SCORE_RE = re.compile(
    r"ScoreMonitor: score=(\d+) stage=(-?\d+) lives=(-?\d+) graze=(-?\d+) epoch_ms=(\d+)")
LOG_TS_RE = re.compile(r"^\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]")


def get_replay_info(replay_path):
    """@sattori/touhou-replay-parser経由でリプレイの記録情報を取得する。"""
    result = subprocess.run(
        ["node", f"{REPO}/scripts/53_get_replay_score.mjs", replay_path, "--json"],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0:
        raise ValueError(f"リプレイの解析に失敗しました: {result.stderr.strip()}")
    return json.loads(result.stdout)


def parse_score_monitor(path):
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


GRAZE_SANITY_CAP = 1_000_000  # これを超えるグレイズ値は実プレイではあり得ない


def drop_garbage_samples(samples):
    """ポインタ間接参照方式(th07/th08)特有のゴミ値サンプルを取り除く。

    このパターンは2箇所で起こりうる:

    1. **先頭**: `GAME_MANAGER->globals`ポインタがNULLから実際のヒープ
       アドレスへ変わった直後の1サンプルだけ、OSがまだゼロクリアしていない
       (前の解放済みメモリの残骸が残っている)メモリを読んでしまうことがある
       (例: `graze=-1878654718`)
    2. **末尾**: リプレイ再生が終わってこの状態構造体がヒープ上で解放される
       と、以後は別用途に再利用されたメモリを読んでしまうことがある(例:
       score=93780038→100737280→119697060(ここまでが本物の最終スコアと
       完全一致)→44568272、graze=2008→44499352)

    スコアの増分は「早いステージでは小さく終盤・ボス撃破ボーナス等で大きく
    跳ねる」ため、スコア側の増分に閾値を設ける方式は誤検知しやすい
    (実際に試したところ正当な終盤の大きい伸びを誤って切り捨ててしまった)。
    一方**グレイズはどのタイトルでもゲーム内で数十万を超えることは現実的に
    あり得ない**ため、グレイズの絶対値に上限を設ける方式のほうが安全。
    上限を超える(または負の)グレイズを持つサンプルを個別に除外する
    (先頭・末尾どちらのパターンにも対応するため、範囲の打ち切りではなく
    行単位のフィルタとする)。
    """
    # graze=-1 は「そのタイトルではグレイズのRVAが未特定で監視していない」ことを
    # 示す明示的な番兵(th06c、フェーズ74)。ゴミ値ではないのでフィルタを適用しない
    # (0を使うと「グレイズ0の正当なサンプル」と区別できなくなるため-1にしている)。
    return [s for s in samples
            if s["graze"] == -1 or 0 <= s["graze"] <= GRAZE_SANITY_CAP]


def quiet_tail_seconds(path, last_sample_epoch_ms):
    """最後のScoreMonitorサンプルから、MODログが途切れるまでの秒数を返す。

    (scripts/50_check_replay_desync.pyと同じロジック。詳細はそちらのdocstring参照)
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
    if log_dt < sample_dt:
        log_dt += datetime.timedelta(days=1)
    return (log_dt - sample_dt).total_seconds()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--game", required=True, choices=sorted(GAME_MULTIPLIERS))
    parser.add_argument("replay", help="リプレイファイル (.rpy)")
    parser.add_argument("log", help="MODのオートプレイログ (<game>_autoplay.log)")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--record-log", default=None,
                        help="scripts/25の実行ログ。強制タイムアウトで打ち切られた録画を"
                             "デシンクと誤判定しないために使う")
    args = parser.parse_args()

    info = get_replay_info(args.replay)
    if info.get("score") is None:
        print(f"ERROR: {args.replay} にスコアが記録されていません", file=sys.stderr)
        sys.exit(2)
    expected = info["score"]

    samples_all = parse_score_monitor(args.log)
    if not samples_all:
        print("ERROR: ログに ScoreMonitor 行がありません "
              "(score_monitor 未組み込みのDLLで録画された可能性があります)",
              file=sys.stderr)
        sys.exit(2)
    samples = drop_garbage_samples(samples_all)
    dropped = len(samples_all) - len(samples)
    if not samples:
        print("ERROR: 全サンプルがゴミ値フィルタで除外されました "
              "(score_monitorのRVAが誤っている可能性があります)", file=sys.stderr)
        sys.exit(2)

    multiplier = GAME_MULTIPLIERS[args.game]
    final_raw = samples[-1]
    peak_display = max(s["score"] for s in samples) * multiplier
    # 「ログ末尾のサンプル」ではなく「記録全体(ゴミ値フィルタ前)のどこかに
    # 記録スコアと完全一致するサンプルがあるか」で一致判定する。
    #
    # th07/th08はポインタ間接参照方式のため、リプレイ終了直後にヒープが
    # 解放・別用途に再利用され、末尾のサンプルが破損することがある
    # (drop_garbage_samplesのdocstring参照)。フェーズ54でth07 ver1.00bを
    # 検証した際、末尾の破損サンプルで**グレイズ/残機は直前と同一のまま
    # スコアだけが書き換わる**新パターンを実機で確認し、グレイズ上限だけでは
    # 検知できなかった(score=30376604(記録スコアと完全一致)の3秒後に
    # score=38797976 graze=2650(直前と同一)という壊れ方をした)。
    #
    # スコアは正常なプレイ中は単調非減少で、記録スコアちょうどの値に到達
    # するのは「そこでリプレイ再生が記録時と同じ結果まで到達した」ことの
    # 動かぬ証拠になる(ゴミ値が偶然ちょうど記録スコアと一致する確率は
    # 無視できるほど小さい)。そのため、この後に何が起きようと(=末尾が
    # 壊れていようと)一致判定は揺るがない。
    matched_sample = next((s for s in samples_all if s["score"] * multiplier == expected), None)
    matched = matched_sample is not None
    # 表示用の「再生時スコア」は、一致した場合はその一致サンプル(末尾が
    # 破損していても正しい値)を、不一致の場合はゴミ値フィルタ後の最終
    # サンプルを使う。
    display_sample = matched_sample if matched else final_raw
    final_display = display_sample["score"] * multiplier

    timed_out = False
    if args.record_log and os.path.exists(args.record_log):
        with open(args.record_log, errors="replace") as f:
            timed_out = "TIMEOUT:" in f.read()

    quiet_tail = quiet_tail_seconds(args.log, final_raw["epoch_ms"])
    QUIET_TAIL_MIN_SEC = 20.0
    cut_while_playing = quiet_tail is not None and quiet_tail < QUIET_TAIL_MIN_SEC
    truncated = timed_out or cut_while_playing

    # stage>=1に達した後に残機が負になった=ゲームオーバー。起動直後のstage=0
    # 区間はタイトルによって負値を経由することがあるため除外する。
    died_out = any(s["lives"] < 0 for s in samples if s["stage"] >= 1)
    cleared = bool(info.get("cleared"))

    if matched:
        verdict = "match"
    elif died_out and cleared:
        verdict = "desync"
    elif truncated:
        verdict = "truncated"
    else:
        verdict = "desync"

    playing = [s for s in samples if s["score"] > 0]
    play_sec = ((playing[-1]["epoch_ms"] - playing[0]["epoch_ms"]) / 1000.0
                if len(playing) >= 2 else 0.0)

    result = {
        "game": args.game,
        "replay": os.path.basename(args.replay),
        "expected_score": expected,
        "final_score_raw": display_sample["score"],
        "final_score_display": final_display,
        "peak_score_display": peak_display,
        "multiplier": multiplier,
        "score_matched": matched,
        "verdict": verdict,
        "timed_out": timed_out,
        "quiet_tail_sec": round(quiet_tail, 1) if quiet_tail is not None else None,
        "died_out": died_out,
        "final_stage": display_sample["stage"],
        "final_lives": display_sample["lives"],
        "final_graze": display_sample["graze"],
        "replay_difficulty": info.get("difficulty"),
        "replay_stage": info.get("stage"),
        "replay_player": info.get("player"),
        "replay_cleared": cleared,
        "play_seconds": round(play_sec, 1),
        "samples": len(samples),
        "dropped_trailing_garbage_samples": dropped,
    }

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"タイトル      : {result['game']}")
        print(f"リプレイ      : {result['replay']} "
              f"({result['replay_difficulty']} / {result['replay_stage']} / {result['replay_player']})")
        print(f"記録時スコア  : {expected:,}")
        print(f"再生時スコア  : {final_display:,} (内部値{display_sample['score']:,}×{multiplier}, "
              f"最大{peak_display:,})")
        print(f"到達ステージ  : {result['final_stage']}  残機: {result['final_lives']}  "
              f"グレイズ: {result['final_graze']:,}")
        print(f"スコア動作時間: {play_sec:.1f}s  サンプル数: {len(samples)}"
              f"{f' (末尾ゴミ値{dropped}件を除外)' if dropped else ''}")
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
