"""MOD(`mods/`)が書き出すログの読み取り。

シーケンス完了等のマーカー待ち・ScoreMonitor によるリプレイずれ(デシンク)の
事後検証(Issue #103)を担う。

**fps暴走検知(旧`scan_fps_runaway()`)は削除済み**([`decisions/0043`](../../docs/decisions/0043-remove-fps-runaway-detection.md))。
MOD側の`fps_monitor.cpp`(GetDeviceStateフックの呼び出し頻度を5秒毎にログ出力する
スレッド)自体は残っているため、`FpsMonitor: N GetDeviceState calls in M ms (H.H Hz)`
行はMODログに引き続き出力されるが、読み取って自動判定に使う経路は無い。
"""
import os
import re
import time


# ---------------------------------------------------------------------------
# リプレイずれ(デシンク)の事後検証(Issue #103)
# ---------------------------------------------------------------------------
# mods/common/score_monitor.* が1秒間隔でMODログへ出力する
# "ScoreMonitor: score=N stage=N lives=N graze=N epoch_ms=N" 行から、リプレイ
# 再生終了時点のゲーム内スコア(生値)を読み取る。th06/07/08/11/20は実機検証済み
# (touhou-recorder reports/53_phase53_score_monitor_all_titles.md)。th10は別途
# reports/57で実機検証済み(mods/th10_replay_autoplay/dllmain.cpp参照)。
SCORE_MONITOR_RE = re.compile(
    r"ScoreMonitor: score=(\d+) stage=(-?\d+) lives=(-?\d+) graze=(-?\d+) epoch_ms=(\d+)"
)

# MOD内部のスコア生値を画面表示値(=リプレイファイルの記録スコアと同じ単位)へ
# 換算する倍率。タイトルごとに実機で確認済みの値
# (reports/53_phase53_score_monitor_all_titles.md)。th06のみ等倍で、他は
# TH10以降のエンジンの慣習(内部値が表示値の1/10)を引き継いでいる。
GAME_SCORE_MULTIPLIERS = {
    "th06": 1,
    "th07": 10,
    "th08": 10,
    "th10": 10,
    "th11": 10,
    "th12": 10,
    "th20": 10,
}

# th07/th08(ポインタ間接参照方式)は、状態構造体が未初期化/解放済みの一瞬だけ
# 別用途のメモリを読んでしまい、グレイズが現実離れした値(例: -1878654718)になる
# 「ゴミ値」サンプルが1回だけ記録されることがある(reports/53参照)。グレイズは
# どのタイトル・どの局面でも現実的な上限を大きく超えることがないため、この範囲を
# 外れたサンプルは機械的に除外する。
GRAZE_GARBAGE_MAX = 1_000_000


def wait_for_log_marker(log_path, marker, timeout, poll_interval=0.1, log_all=False, seen_lines=None, log=print):
    if seen_lines is None:
        seen_lines = set()
    t0 = time.time()
    while time.time() - t0 < timeout:
        if os.path.exists(log_path):
            with open(log_path) as f:
                lines = f.readlines()
            for line in lines:
                if line in seen_lines:
                    continue
                seen_lines.add(line)
                if log_all:
                    log(f"MODログ: {line.strip()}")
                if marker in line:
                    return time.time()
        time.sleep(poll_interval)
    return None


def read_verified_scores(log_path, game_id):
    """MODのScoreMonitorログから、ゴミ値を除いた画面表示相当スコアを記録順の
    リストで読み取る(有効なサンプルが1つも無ければ空リスト)。

    th07/th08(ポインタ間接参照方式)は状態構造体が解放された直後に別用途で
    再利用されたメモリを読んでしまう「ゴミ値」サンプルが末尾に記録されることが
    ある。グレイズが現実的な上限を超える/負の値になっているサンプル
    (GRAZE_GARBAGE_MAX参照)はこの時点で除外するが、**グレイズは直前のまま
    スコアだけ壊れるパターンもあり、この段階のフィルタだけでは検知しきれない**
    (touhou-recorder reports/54でth07 ver1.00bにて実機確認)。呼び出し側
    (check_replay_desync())は「最後の1件」ではなく「記録全体のどこかに記録
    スコアと完全一致するサンプルがあるか」で判定することでこれに対処する。"""
    if not os.path.exists(log_path):
        return []
    with open(log_path) as f:
        text = f.read()
    multiplier = GAME_SCORE_MULTIPLIERS.get(game_id, 1)
    scores = []
    for m in SCORE_MONITOR_RE.finditer(text):
        score, graze = int(m.group(1)), int(m.group(4))
        if graze < 0 or graze > GRAZE_GARBAGE_MAX:
            continue
        scores.append(score * multiplier)
    return scores


def check_replay_desync(config, expected_score, log=print):
    """録画中に記録されたゲーム内スコアの推移と、リプレイファイルに記録された
    最終スコアを突き合わせ、リプレイずれ(デシンク)が疑われるかを判定する
    (Issue #103)。

    MODがRVA直指定で読んでいる生値に基づく検証であり、信頼性が高いとは言えない
    (ゲームデータのバージョン差で無意味な値になりうる、reports/53)。そのため
    不一致を検知しても自動リトライ・失敗扱いはせず、警告として記録するだけに
    留める(呼び出し側がJobsTableへ書き込み、ユーザーには注意書きとして表示する)。

    判定は「記録全体(ゴミ値フィルタ後)のどこかに記録スコアとちょうど一致する
    サンプルがあるか」で行う。スコアは正常なプレイ中は単調非減少で、記録スコア
    ちょうどの値に到達するのは「そこでリプレイ再生が記録時と同じ結果まで到達
    した」ことの動かぬ証拠になる(ゴミ値が偶然ちょうど記録スコアと一致する確率は
    無視できるほど小さい)ため、一致した後に何が起きようと(=末尾のゴミ値で
    最終サンプルが壊れていようと)判定は揺るがない(touhou-recorder
    reports/54_phase54_th07_ver100b_reverification.md、旧: 末尾サンプルのみを
    見る実装ではこの末尾ゴミ値パターンを誤って不一致と判定していた)。

    戻り値: True=不一致(リプレイずれの疑い)、False=一致、None=検証できなかった
    (期待スコア未取得、またはMODのログから有効なスコアが読み取れなかった)。
    """
    if expected_score is None:
        return None
    scores = read_verified_scores(config.log_path, config.game_id)
    if not scores:
        log("リプレイずれ検証: MODのスコアログが取得できなかったため検証をスキップしました")
        return None
    if expected_score in scores:
        log(f"リプレイずれ検証: 記録スコア({expected_score})と一致するサンプルを確認しました")
        return False
    log(
        f"WARNING: リプレイずれの可能性があります。記録スコア({expected_score})と一致する"
        f"サンプルが見つかりませんでした(最終観測値: {scores[-1]})"
    )
    return True
