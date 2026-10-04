"""配信版から落とすリプレイ再生区間外のカット範囲(Issue #266)。

録画にはMODのメニュー自動操作と、リプレイ終了を確定させるまでの静止画面(選択画面)が
含まれる。リプレイを動画にするという目的からは不要なので、配信用変換(`convert.py`)で
落とす。ここではその範囲を**mux後の動画(`video.mp4`)の時間軸の秒数**で決め、
`entrypoint.py`へファイル経由で渡す(`artifacts.write_cut_result()`)。

- **開始**: MODがリプレイの再生を確定するキーを押す`REPLAY_START_LEAD_SEC`秒前
  (ゲーム内時間、`modlog.find_replay_start_epoch()`)。リプレイ選択画面に出るプレイヤー名・
  日時・スコアを動画に残すため。決められなければ映像の先頭(音声だけが先に始まっている区間は
  落とす。`pipeline.attempt_recording()`は音声の録音を映像より先に始める)。
- **終了**: 終了検知(画面静止・テンプレート照合)の連続一致が始まったフレーム
  (`pipeline._monitor_until_end()`の`content_end_epoch`)。

どちらも壁時計時刻(epoch秒)で得られるので、映像の先頭フレームの壁時計時刻
(`-copyts`で保持したstart_time、`recording/__init__.py`)を基準に動画の時間軸へ換算する。
決められなかった側はNoneにし、変換側はそちらをカットしない(録画自体は失敗させない)。
"""
import subprocess

from . import sync_marker
from .ffmpeg import ffprobe_start_time
from .modlog import find_replay_start_epoch

# リプレイの再生を確定するキーを押す何秒前から残すか(ゲーム内時間=等倍の動画上の秒数)。
REPLAY_START_LEAD_SEC = 1.0
# 同期マーカーが鳴り終わってから何秒あけてカットを始めるか(Wineの出力遅延ぶんの余裕)。
MARKER_TAIL_MARGIN_SEC = 0.3
# 開始より手前に終了が来る・極端に短い、といった明らかにおかしい範囲では終了側を捨てる。
MIN_CUT_DURATION_SEC = 1.0


def output_video_offset(output_path, env):
    """mux後の動画で、映像ストリームがファイル先頭から何秒後に始まるか。

    mux(`ffmpeg._run_mux()`)は音声の方が先に始まった場合に映像を`-itsoffset`で後ろへずらす
    ので、0とは限らない。取得できなければNone。"""
    def probe(args):
        return subprocess.run(
            ["ffprobe", "-v", "error", *args, "-of", "csv=p=0", output_path],
            capture_output=True, text=True, env=env, timeout=30,
        ).stdout.strip()
    try:
        stream = probe(["-select_streams", "v:0", "-show_entries", "stream=start_time"])
        fmt = probe(["-show_entries", "format=start_time"])
        return float(stream.splitlines()[0]) - float(fmt)
    except (ValueError, IndexError, subprocess.SubprocessError, OSError):
        return None


def compute_cut_range(config, video_target, output_path, env, *, time_scale, content_end_epoch,
                      reference_epoch, log=print):
    """カット範囲 `{"startSec": float|None, "endSec": float|None}` を返す(モジュール docstring)。

    `video_target`はmux前の映像の中間ファイル(`-copyts`の壁時計start_timeを持つ)、
    `output_path`はmux後の動画。秒数は**等倍へ戻す前**の`output_path`の時間軸。
    """
    cut = {"startSec": None, "endSec": None}
    v_start = ffprobe_start_time(video_target, env)
    v_offset = output_video_offset(output_path, env)
    if v_start is None or v_offset is None:
        log("WARNING: 映像の開始時刻を取得できなかったため、配信版のカットをスキップします")
        return cut

    def to_output_sec(epoch):
        return v_offset + (epoch - v_start)

    start_epoch = find_replay_start_epoch(config.log_path, reference_epoch=reference_epoch)
    if start_epoch is None:
        log("WARNING: MODログにリプレイ再生確定の記録が無いため、配信版の先頭は映像の先頭からにします")
        cut["startSec"] = v_offset if v_offset > 0 else None
    else:
        # 実時間はゲーム内時間の time_scale 倍(倍速録画ではメニュー操作も実時間で縮む)。
        cut["startSec"] = max(v_offset, to_output_sec(start_epoch - REPLAY_START_LEAD_SEC * time_scale))
        # 同期マーカー(約3秒のノイズ)は配信版に残さない。マーカーはゲームの初期化が済んでから
        # 鳴らすので(`sync_marker.schedule_trigger()`)、メニュー操作の速いタイトルでは
        # 鳴り終わりが上の開始位置より後ろになりうる。その場合は開始を鳴り終わりまで遅らせる
        # (リプレイ選択画面を見せる時間が少し短くなるだけ)。
        marker = sync_marker.parse_marker_log(config.log_path, log=log)
        if marker is not None:
            marker_end = to_output_sec(
                marker["epoch"] + marker["samples"] / marker["rate"] + MARKER_TAIL_MARGIN_SEC)
            if marker_end > cut["startSec"]:
                log(f"同期マーカーの鳴り終わり({marker_end:.3f}s)まで配信版の開始を遅らせます"
                    f"(本来の開始 {cut['startSec']:.3f}s)")
                cut["startSec"] = marker_end

    if content_end_epoch is not None:
        end_sec = to_output_sec(content_end_epoch)
        start_sec = cut["startSec"] or 0.0
        if end_sec - start_sec < MIN_CUT_DURATION_SEC * time_scale:
            log(f"WARNING: カット終了位置({end_sec:.3f}s)が開始位置({start_sec:.3f}s)に近すぎるため、"
                "末尾はカットしません")
        else:
            cut["endSec"] = end_sec

    log(f"配信版のカット範囲(録画の時間軸): start={cut['startSec']} end={cut['endSec']} "
        f"(映像の先頭フレーム={v_start:.3f} 映像のオフセット={v_offset:.3f}s)")
    return cut
