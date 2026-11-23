"""MOD統合テスト(`run.py`)のフレーム同期キャプチャ向けの検証項目。

フレーム同期では録画対象のゲームがフレーム単位で決定的に動くので、実時間の録画では
取れなかった次の種類の検証ができる。ここには**ログ・動画から値を取り出す関数と判定関数**
(副作用なし、`tests/test_mod_integration_checks.py`でユニットテストする)を置き、
録画の実行・ファイル操作は`run.py`が受け持つ。

- 三者照合・仮想音声ミキサの整合・MODログのエラー有無(フレーム数の食い違い・取りこぼし)
- 取り込みサイズ・出力動画の形式(解像度・fps・音声の長さ・無音でないこと・画面が真っ黒でないこと)
- 再生区間の長さ(リプレイの再生を始めたフレームから終了検知まで)の基準値との比較
- 最終スコアに到達した時点の(ステージ・残機・グレイズ)の完全一致
- 被弾した時点の**ゲーム内の時刻**(リプレイ再生開始からの秒)の基準値との比較

ScoreMonitorは実時間20ms間隔のポーリングで、行にフレーム番号は無い。フレーム同期ではゲームが
可変速で進むので、実時間の差は意味を持たない。そこでMODログの`FrameSync: stats frame=N`
(600フレームごと、行頭に実時間)から実時間→フレーム番号の対応を作り、線形補間でフレーム番号へ
換算する(誤差は補間区間内のfpsの揺れで最大1秒程度)。
"""
import re

from recording.modlog import GAME_SCORE_MULTIPLIERS, GRAZE_GARBAGE_MAX, SCORE_MONITOR_RE

NATIVE_FRAME_RATE_HZ = 60.0
SECONDS_PER_DAY = 24 * 60 * 60

LOG_LINE_TIME_RE = re.compile(r"^\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\] ")
STATS_RE = re.compile(r"FrameSync: stats frame=(\d+) written=(\d+)")
UNTHROTTLED_RE = re.compile(r"FrameSync: unthrottled=1 at frame=(\d+)")
CAPTURE_STOPPED_RE = re.compile(
    r"FrameSync: capture stopped frames_written=(\d+) present_count=(\d+)")
CAPTURE_START_RE = re.compile(r"FrameSync: capture start width=(\d+) height=(\d+)")
AUDIO_CLOSED_RE = re.compile(
    r"FrameSyncAudio: closed frames_written=(\d+) frames_mixed=(\d+) notifies=\d+ "
    r"refill_timeouts=(\d+) unknown_plays=(\d+)")
# 録画側(recording/framesync.py)が標準出力へ書く行。
FRAME_COUNTS_RE = re.compile(
    r"\[FRAME_SYNC\] MODが書いたフレーム数=(\d+) 動画のフレーム数=(\d+) 音声のフレーム数=(\d+)"
    r"\(PCMの端数(\d+)バイト\) 一致=(OK|NG)")
PLAY_SEC_RE = re.compile(r"\[FRAME_SYNC\] 理論尺との比較: 再生区間([0-9.]+)秒")
# MODが異常を知らせる行。FrameSyncSleepMs/FrameSyncWaitPresentFramesのTIMEOUTは、ゲームのスレッドが
# 待ちきれずに時計の仮想化を諦めた印(その区間は決定的でなくなる)。
MOD_ERROR_RES = (
    re.compile(r"FrameSync: ERROR"),
    re.compile(r"FrameSync(?:SleepMs|WaitPresentFrames): TIMEOUT"),
)

# 最終スコアのサンプルと被弾時刻の比較の許容(秒)。
HIT_TIMING_TOLERANCE_SECONDS = 2.0
PLAY_DURATION_TOLERANCE_SECONDS = 2.5  # 終了検知は動画の2秒おきの格子で決まる
AUDIO_DURATION_TOLERANCE_SECONDS = 0.1
# 無音の判定(dBFS)。MODの仮想ミキサが壊れると完全な無音(-inf)か極端に小さい値になる。
MIN_AUDIO_MAX_VOLUME_DB = -40.0
# 画面が真っ黒/真っ白でないことの判定(gray 0〜255の標準偏差)。
MIN_FRAME_STDDEV = 8.0


def read_text(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def _seconds_of_day(m):
    hour, minute, second, millis = (int(g) for g in m.groups())
    return hour * 3600 + minute * 60 + second + millis / 1000


def timestamped_lines(text):
    """(日付をまたいでも単調増加する実時間の秒, 行)のリスト。行頭の時刻が無い行は飛ばす。"""
    result = []
    day_offset = 0.0
    prev = None
    for line in text.splitlines():
        m = LOG_LINE_TIME_RE.match(line)
        if not m:
            continue
        sod = _seconds_of_day(m)
        if prev is not None and sod + day_offset < prev - SECONDS_PER_DAY / 2:
            day_offset += SECONDS_PER_DAY
        t = sod + day_offset
        prev = t
        result.append((t, line))
    return result


def frame_time_anchors(lines):
    """実時間→フレーム番号の対応点(実時間の昇順)。stats行・上限解除の行・取り込み停止の行を使う。"""
    anchors = []
    for t, line in lines:
        m = STATS_RE.search(line)
        if m:
            anchors.append((t, int(m.group(1))))
            continue
        m = UNTHROTTLED_RE.search(line)
        if m:
            anchors.append((t, int(m.group(1))))
            continue
        m = CAPTURE_STOPPED_RE.search(line)
        if m:
            anchors.append((t, int(m.group(1))))
    anchors.sort()
    return anchors


def frame_at(anchors, t):
    """実時間tのフレーム番号(対応点の間は線形補間、範囲外は端の値)。対応点が無ければNone。"""
    if not anchors:
        return None
    if t <= anchors[0][0]:
        return float(anchors[0][1])
    for (t0, f0), (t1, f1) in zip(anchors, anchors[1:]):
        if t0 <= t <= t1:
            if t1 == t0:
                return float(f1)
            return f0 + (f1 - f0) * (t - t0) / (t1 - t0)
    return float(anchors[-1][1])


def read_samples(lines, game_id):
    """ScoreMonitorのゴミ値でないサンプルを(実時間, 画面表示相当スコア, ステージ, 残機, グレイズ)で返す。"""
    multiplier = GAME_SCORE_MULTIPLIERS.get(game_id, 1)
    samples = []
    for t, line in lines:
        m = SCORE_MONITOR_RE.search(line)
        if not m:
            continue
        graze = int(m.group(4))
        if graze < 0 or graze > GRAZE_GARBAGE_MAX:
            continue
        samples.append((t, int(m.group(1)) * multiplier, int(m.group(2)), int(m.group(3)), graze))
    return samples


def read_game_hit_times(text, game_id, replay_start_frame):
    """残機が減った時点の、リプレイ再生開始からの**ゲーム内の秒**のリスト。

    起動直後のゴミ値(例: th20でstage=0のまま一瞬lives=-1)を避けるため、リプレイの再生を始める前の
    サンプルは数えない。換算できなければ空リスト。
    """
    lines = timestamped_lines(text)
    anchors = frame_time_anchors(lines)
    if replay_start_frame is None or not anchors:
        return []
    hits = []
    prev_lives = None
    for t, _score, _stage, lives, _graze in read_samples(lines, game_id):
        frame = frame_at(anchors, t)
        if frame is None or frame < replay_start_frame:
            prev_lives = lives
            continue
        if prev_lives is not None and lives < prev_lives:
            hits.append(round((frame - replay_start_frame) / NATIVE_FRAME_RATE_HZ, 1))
        prev_lives = lives
    return hits


def read_final_state(text, game_id, expected_score):
    """記録スコアに到達したサンプルのうち最後のものの(ステージ, 残機, グレイズ)。無ければNone。

    リプレイが決定的に再生されていれば、最終スコアの時点の残機・グレイズも毎回一致する。
    スコアを監視しないタイトル(`expected_score`がNone)では判定できない。
    """
    if expected_score is None:
        return None
    final = None
    for _t, score, stage, lives, graze in read_samples(timestamped_lines(text), game_id):
        if score == expected_score:
            final = (stage, lives, graze)
    return final


def read_audio_closed(text):
    """`FrameSyncAudio: closed`行を(書いた数, 混ぜた数, 待ちのタイムアウト数, 未知のPlay数)で。無ければNone。"""
    m = AUDIO_CLOSED_RE.search(text)
    return tuple(int(m.group(i)) for i in range(1, 5)) if m else None


def read_capture_size(text):
    m = CAPTURE_START_RE.search(text)
    return (int(m.group(1)), int(m.group(2))) if m else None


def read_capture_stopped(text):
    m = CAPTURE_STOPPED_RE.search(text)
    return (int(m.group(1)), int(m.group(2))) if m else None


# ---------------------------------------------------------------------------
# 判定。どれも違反の説明のリストを返す(空なら合格)。
# ---------------------------------------------------------------------------
def check_frame_counts(run_log):
    """三者照合が通っていること、かつ3つの数が実際に一致していること。"""
    m = FRAME_COUNTS_RE.search(run_log)
    if not m:
        return ["録画ログに三者照合の行が無い"]
    written, video, audio, remainder, verdict = int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4)), m.group(5)
    problems = []
    if verdict != "OK" or remainder != 0 or not (written == video == audio):
        problems.append(
            f"三者照合NG(MOD={written} 動画={video} 音声={audio} 端数{remainder}バイト)")
    return problems


def check_mod_log(mod_log, max_refill_timeouts=0):
    """MODログのフレーム同期の整合(取り込み停止・仮想ミキサ・異常行)。"""
    problems = []
    stopped = read_capture_stopped(mod_log)
    audio = read_audio_closed(mod_log)
    if stopped is None:
        problems.append("MODログに`capture stopped`が無い")
    if audio is None:
        problems.append("MODログに`FrameSyncAudio: closed`が無い")
    if stopped is not None:
        written, present = stopped
        # 最初のPresentは書かない(次のフレームから書く)ので差は1のはず。
        if present - written != 1:
            problems.append(f"Present回数と書き出し数の差が1でない(present={present} written={written})")
    if stopped is not None and audio is not None:
        a_written, mixed, refill_timeouts, unknown_plays = audio
        if not (stopped[0] == a_written == mixed):
            problems.append(
                f"仮想ミキサのフレーム数が食い違う(映像{stopped[0]} 音声書き出し{a_written} ミックス{mixed})")
        if refill_timeouts > max_refill_timeouts:
            problems.append(
                f"仮想ミキサの補充待ちがタイムアウトした({refill_timeouts}回、許容{max_refill_timeouts}回)")
        if unknown_plays != 0:
            problems.append(f"未知のバッファのPlayがあった({unknown_plays}回、音が欠けている可能性)")
    for regex in MOD_ERROR_RES:
        found = regex.search(mod_log)
        if found:
            problems.append(f"MODログに異常行がある: {found.group(0)}")
    return problems


def check_capture_size(mod_log, expected_size):
    if expected_size is None:  # 基準値の採取中
        return []
    size = read_capture_size(mod_log)
    if size is None:
        return ["MODログに`capture start`が無い"]
    if size != tuple(expected_size):
        return [f"取り込みサイズが基準と異なる(基準{tuple(expected_size)} 実測{size})"]
    return []


def check_play_duration(run_log, expected_play_sec):
    """再生区間(リプレイ再生開始〜終了検知)が基準値から大きくずれていないこと。

    本番の合否判定(理論尺との比較: 短い側-30%・長い側+10%)は「再生されなかった・途中で止まった」を
    弾くための緩い値。こちらは1回実機で採った基準値との比較で、MODの退行による数秒単位の変化を拾う。
    """
    if expected_play_sec is None:  # 基準値の採取中
        return []
    m = PLAY_SEC_RE.search(run_log)
    if not m:
        return ["録画ログに再生区間の行が無い(終了検知できなかった可能性)"]
    play = float(m.group(1))
    if abs(play - expected_play_sec) > PLAY_DURATION_TOLERANCE_SECONDS:
        return [f"再生区間が基準から{play - expected_play_sec:+.1f}秒ずれている(基準{expected_play_sec}秒 実測{play}秒)"]
    return []


def check_final_state(actual, expected):
    """最終スコア時点の(ステージ, 残機, グレイズ)が完全一致すること。"""
    if expected is None:
        return []
    if actual is None:
        return ["記録スコアに到達したサンプルが無く、最終状態を比較できない"]
    if tuple(actual) != tuple(expected):
        return [f"最終スコア時点の(ステージ,残機,グレイズ)が基準と異なる(基準{tuple(expected)} 実測{tuple(actual)})"]
    return []


def check_hit_times(actual, expected):
    """被弾回数が一致し、各被弾のゲーム内時刻が基準値から許容内であること。"""
    if expected is None:
        return []
    if not actual:
        return ["被弾時刻を取得できなかった(MODログから残機の変化または時刻対応が得られない)"]
    if len(actual) != len(expected):
        return [f"被弾回数が基準と異なる(基準{len(expected)}回{expected} 実測{len(actual)}回{actual})"]
    max_diff = max(abs(a - e) for a, e in zip(actual, expected))
    if max_diff > HIT_TIMING_TOLERANCE_SECONDS:
        return [f"被弾時刻が基準から{max_diff:.1f}秒ずれている(基準{expected} 実測{actual})"]
    return []


def check_video_info(info, expected_size, expected_frames):
    """ffprobeの結果(`{"video": {...}, "audio": {...}}`)が期待どおりであること。"""
    problems = []
    video, audio = info.get("video"), info.get("audio")
    if not video:
        return ["出力に映像ストリームが無い"]
    if not audio:
        problems.append("出力に音声ストリームが無い")
    out_size = (video.get("width"), video.get("height"))
    if expected_size is not None and out_size != tuple(expected_size):
        problems.append(f"出力動画の解像度が取り込みサイズと異なる(期待{tuple(expected_size)} 実測{out_size})")
    if video.get("r_frame_rate") != "60/1":
        problems.append(f"出力動画のフレームレートが60fpsでない({video.get('r_frame_rate')})")
    if expected_frames is not None and video.get("nb_frames") not in (None, expected_frames):
        problems.append(f"出力動画のフレーム数が書き出し数と異なる(期待{expected_frames} 実測{video.get('nb_frames')})")
    if audio and video.get("duration") is not None and audio.get("duration") is not None:
        diff = abs(video["duration"] - audio["duration"])
        if diff > AUDIO_DURATION_TOLERANCE_SECONDS:
            problems.append(
                f"映像と音声の長さが{diff:.2f}秒ずれている(映像{video['duration']:.2f}秒 音声{audio['duration']:.2f}秒)")
    return problems


def check_audible(max_volume_db):
    """音声が無音でないこと(`volumedetect`のmax_volume。無音ならNone/-inf)。"""
    if max_volume_db is None or max_volume_db < MIN_AUDIO_MAX_VOLUME_DB:
        return [f"音声がほぼ無音(max_volume={max_volume_db}dB、基準{MIN_AUDIO_MAX_VOLUME_DB}dB以上)"]
    return []


def check_frames_not_blank(stddevs):
    """抜き出した各フレームの輝度の標準偏差が`MIN_FRAME_STDDEV`以上であること(真っ黒・真っ白でない)。"""
    if not stddevs:
        return ["画面の確認用フレームを取り出せなかった"]
    blank = [i for i, s in enumerate(stddevs) if s < MIN_FRAME_STDDEV]
    if blank:
        return [f"画面が単色に近いフレームがある(位置{blank}、標準偏差{[round(stddevs[i], 1) for i in blank]})"]
    return []
