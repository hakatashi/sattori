"""録画の実行モード(通常のリトライ付き録画・固定秒数録画・統計取り)。

`recorder/pipeline.py`の`attempt_recording()`が「1回の試行」なのに対し、こちらは
**何回試すか・結果をどう判定するか**を受け持つ。いずれも成功したらTrueを返す
(プロセスを終了させるのは`recorder/cli.py`の役目)。
"""
from collections import Counter

from .ffmpeg import measure_duplicate_rate
from .log import log
from .pipeline import attempt_recording

# 重複フレーム率を測る区間。録画開始直後は初期同期の乱れがあるため15秒スキップし、
# そこから最大30秒を見る。
DUP_WINDOW_START_SEC = 15.0
DUP_WINDOW_MAX_SEC = 30.0
DUP_WINDOW_MIN_SEC = 5.0


def record_with_retry(config, options):
    """正常な録画が得られるまで`max_attempts`回まで試す(通常の録画モード)。

    「正常」の条件は、出力ファイルが存在し、fps暴走・処理落ちの早期検知に引っかからず、
    かつ録画序盤の重複フレーム率が閾値以下であること。
    """
    for attempt in range(1, options.max_attempts + 1):
        log(f"=== 試行 {attempt}/{options.max_attempts} ===")
        result = attempt_recording(config, options)
        if not result.output_exists:
            log("WARNING: 出力ファイルが生成されなかったため、この試行は失敗として扱います")
            continue
        if result.classification == "fps_runaway":
            log(f"WARNING: fps暴走({result.fps_runaway_hz:.1f}Hz)を検知したため破棄して"
                "リトライします")
            continue
        if result.classification == "stutter":
            log("WARNING: 処理落ちの早期検知によりこの試行を破棄してリトライします")
            continue

        dup_rate = _measure_playback_duplicate_rate(options.output, result)
        if dup_rate is None:
            # 空の動画・壊れた動画では計測できずNoneになる。これを「異常なし」と扱うと、
            # 1フレームも録れていない録画が成功扱いになってしまう(フェーズ81、x11grabが
            # ウィンドウ画面外で失敗した際に実際に発生)。
            log("WARNING: 重複フレーム率を計測できませんでした(動画が空か壊れています)。"
                "この試行は失敗として扱います")
            continue
        if dup_rate > options.max_duplicate_rate:
            log(f"WARNING: 重複フレーム率({dup_rate}%)が閾値({options.max_duplicate_rate}%)を"
                "超えました。処理落ちの疑いがあるため破棄してリトライします")
            continue
        log(f"試行{attempt}で正常な録画を確認しました")
        return True

    log(f"ERROR: {options.max_attempts}回試行しても正常な録画が得られませんでした")
    return False


def _measure_playback_duplicate_rate(output_path, result):
    """リプレイ本編の区間だけを対象に重複フレーム率を測る。

    終了検知の静止画面(尾部)は「動きが無くて当たり前」の区間なので計測から外す。
    尾部を除いた実プレイ区間が5秒未満しか無い場合だけ、従来どおり尾部込みで測る
    (それ以下では区間の取りようが無く、そもそも判定材料にならない)。
    """
    window_end = result.total_record_sec - result.end_detect_tail_sec
    if window_end - DUP_WINDOW_START_SEC >= DUP_WINDOW_MIN_SEC:
        duration = min(DUP_WINDOW_MAX_SEC, window_end - DUP_WINDOW_START_SEC)
    else:
        duration = min(DUP_WINDOW_MAX_SEC,
                       max(DUP_WINDOW_MIN_SEC, result.total_record_sec - DUP_WINDOW_START_SEC))
    dup_rate = measure_duplicate_rate(output_path, DUP_WINDOW_START_SEC, duration)
    log(f"録画開始{DUP_WINDOW_START_SEC:.0f}秒以降({duration:.0f}秒間)の重複フレーム率: {dup_rate}%")
    return dup_rate


def record_fixed_seconds(config, options):
    """`--record-seconds`の高速検証モード: 1回だけ固定秒数録画し、全体の重複フレーム率を報告する。

    リプレイ終了検知を待たずに済むため、処理落ちの有無だけを見たいとき(インスタンス
    タイプ比較・MOD変更の影響確認等)に使う。リトライはしない。
    """
    result = attempt_recording(config, options)
    if not result.output_exists:
        log("ERROR: 出力ファイルが生成されませんでした")
        return False
    total = result.total_record_sec
    # 録画開始15秒(初期同期猶予)以降〜末尾5秒手前までの広い区間で計測する。
    win_start = DUP_WINDOW_START_SEC
    win_dur = max(DUP_WINDOW_MIN_SEC, total - win_start - 5.0)
    dup_rate = measure_duplicate_rate(options.output, win_start, win_dur)
    log(f"[RESULT] game={config.game_id} 総録画={total:.1f}s "
        f"計測区間={win_start:.0f}..{win_start+win_dur:.0f}s 重複フレーム率={dup_rate}%")
    return True


def run_stats(config, options):
    """同じ条件で`stats_runs`回録画し、分類ごとの件数と成功率を集計する。

    録画の安定性そのものを評価するモード(フェーズ25のth07/th08比較のように、
    タイトルや環境ごとの成功率を出したいとき)。
    """
    n = options.stats_runs
    if options.quick_classify_sec is None:
        options.quick_classify_sec = 60.0
        log(f"--quick-classify-sec未指定のため既定値{options.quick_classify_sec:.0f}秒を使用します")

    results = []
    for i in range(1, n + 1):
        log(f"=== 統計試行 {i}/{n} ===")
        result = attempt_recording(config, options)
        results.append(result)
        log(f"試行{i}結果: classification={result.classification} "
            f"total_record_sec={result.total_record_sec:.1f}s")

    counts = Counter(r.classification for r in results)
    log(f"=== 統計結果(game={config.game_id}, replay={options.replay}, n={n}, "
        f"quick_classify_sec={options.quick_classify_sec:.0f}) ===")
    for key in ("good", "fps_runaway", "stutter", "timeout"):
        c = counts.get(key, 0)
        log(f"  {key}: {c}/{n} ({c / n * 100:.1f}%)")
    known = sum(counts.get(key, 0) for key in ("good", "fps_runaway", "stutter", "timeout"))
    if known < n:
        log(f"  other: {n - known}/{n} ({(n - known) / n * 100:.1f}%)")
    good = counts.get("good", 0)
    log(f"成功率: {good}/{n} ({good / n * 100:.1f}%)")
    return True
