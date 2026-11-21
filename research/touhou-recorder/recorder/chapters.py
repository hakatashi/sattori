"""MODログの`StageMarker:`行から、動画のチャプター(ステージ開始・弾幕パターン)を作る。

MOD(`mods/common/stage_marker_hook.*` / `stage_marker_io.*`)は、ステージ遷移や弾幕
パターンの切り替わりを検出するたびに、ゲーム内フレーム番号と`epoch_ms`(UNIXエポック
からのミリ秒)を添えてログへ書く。ここではそれを「動画先頭からの経過秒」へ変換し、
YouTubeの説明欄へそのまま貼れる形式(`.chapters.txt`)とJSON(`.chapters.json`)で
書き出す(フェーズ49)。

変換の基準になる「動画のt=0に対応する絶対時刻」は、`-copyts`で保持した映像側の
start_timeの実測値(`recorder/ffmpeg.py`)を使う。録画開始時刻の推定には頼らない
(推定は誤差要因になるため、実測できない場合はチャプター出力自体をスキップする)。
"""
import json
import os
import re

from .log import log

STAGE_MARKER_RE = re.compile(
    r"StageMarker: stage=(\d+) prev=(\d+) frame=(-?\d+) epoch_ms=(\d+)"
)
REPLAY_START_MARKER_RE = re.compile(
    r"StageMarker: replay_start frame=(-?\d+) epoch_ms=(\d+)"
)
# 弾幕パターン(通常弾幕・スペルカード)のマーカー(mods/common/stage_marker_hook.*)
PATTERN_MARKER_RE = re.compile(
    r"StageMarker: pattern limit=(\d+) prev=(\d+) frame=(-?\d+) epoch_ms=(\d+)"
)
SPELL_FLAG_RE = re.compile(
    r"StageMarker: spell flag=(\d) frame=(-?\d+) epoch_ms=(\d+)"
)
# ファイルI/O方式(th20、mods/common/stage_marker_io.*)のステージロードマーカー
STAGE_LOAD_MARKER_RE = re.compile(
    r"StageMarker: stage_load file=(\S+) bytes=(\d+) reads=(\d+) frame=(-?\d+) epoch_ms=(\d+)"
)


def fmt_timestamp(sec):
    """YouTubeの説明欄にそのまま貼れる MM:SS / H:MM:SS 形式にする(秒は切り捨て)。"""
    sec = max(0, int(sec))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def write_stage_chapters(log_path, output_path, video_epoch_start, time_scale=1.0):
    """MODログのStageMarker行(mods/common/stage_marker_hook.*)を、動画先頭からの
    経過秒に変換してチャプター一覧として書き出す(フェーズ49)。

    video_epoch_start は「動画のt=0に対応する絶対時刻(epoch秒)」。ffmpegの
    -copytsで保持した映像側start_timeをそのまま使えるため、録画開始時刻の推定に
    頼らず実測値で変換できる。

    time_scale はth20のスローモーション録画(FPS_LIMIT_TARGET_HZ、reports/47)を
    `scripts/47_descale_th20_slowmo.py`で等倍化した後の動画に対応させるための係数。
    等倍録画では1.0。
    """
    if not os.path.exists(log_path) or video_epoch_start is None:
        return None
    def to_video_time(epoch_ms):
        return (int(epoch_ms) / 1000.0 - video_epoch_start) * time_scale

    marks = []
    loads = []
    replay_start = None
    with open(log_path, errors="replace") as f:
        for line in f:
            sl = STAGE_LOAD_MARKER_RE.search(line)
            if sl:
                _file, nbytes, reads, frame, epoch_ms = sl.groups()
                t = to_video_time(epoch_ms)
                loads.append({
                    "epoch": int(epoch_ms) / 1000.0,
                    "stage": len(loads) + 1,
                    "game_frame": int(frame),
                    "time_sec": round(t, 3),
                    "timestamp": fmt_timestamp(t),
                    "load_bytes": int(nbytes),
                    "source": "asset_load_burst",
                })
                continue
            rs = REPLAY_START_MARKER_RE.search(line)
            if rs:
                frame, epoch_ms = rs.groups()
                replay_start = {
                    "epoch": int(epoch_ms) / 1000.0,
                    "stage": 1,
                    "prev_stage": 0,
                    "game_frame": int(frame),
                    "time_sec": round(to_video_time(epoch_ms), 3),
                    "timestamp": fmt_timestamp(to_video_time(epoch_ms)),
                    "source": "replay_start",
                }
                continue
            m = STAGE_MARKER_RE.search(line)
            if not m:
                continue
            stage, prev, frame, epoch_ms = m.groups()
            t = to_video_time(epoch_ms)
            marks.append({
                "epoch": int(epoch_ms) / 1000.0,
                "stage": int(stage),
                "prev_stage": int(prev),
                "game_frame": int(frame),
                "time_sec": round(t, 3),
                "timestamp": fmt_timestamp(t),
                "source": "stage_variable",
            })
    # ステージ番号変数が使えないゲーム(th20)は、アセットロードバースト由来の
    # マーカーだけを使う(stage_marker_io.h参照)。両方が出ることは想定していないが、
    # 出た場合はより直接的なステージ番号変数側を優先する。
    if not marks and loads:
        marks = loads
    # ステージ番号変数側で1面が取れないゲーム(th08)では、MODが出す
    # replay_startマーカーを1面の開始として補う(stage_marker_hook.h参照)。
    elif replay_start is not None and not any(m["stage"] == 1 for m in marks):
        marks.insert(0, replay_start)

    # 表示上の「N面」は、ゲーム内部のステージIDではなく出現順で振る。
    # th08は4面A/4面B・Final A/Finalの分岐があるぶん内部IDが飛び番になっており
    # (実測で 0,1,2,4,5,7 と観測)、内部IDをそのまま「N面」として表示すると
    # 4面が「5面」、6面が「8面」と表示されてしまうため。
    # 内部IDはstage_idとしてJSONに残すので、将来ID→表示名の対応表を作るときに
    # 使える(Extraステージ・スペルプラクティス等、出現順の連番が適切でない
    # リプレイ種別への対応は未実装)。
    for i, m in enumerate(marks, start=1):
        m["stage_id"] = m.pop("stage")
        m["index"] = i
        m["label"] = f"{i}面"
        m.pop("prev_stage", None)

    if not marks:
        log("StageMarkerログが無かったため、ステージ開始時刻の出力はスキップします")
        return None

    # 録画開始前(負の時刻)のマーカーは、リプレイ選択画面等での初期化に伴うもの
    # なので除外する。
    marks = [m for m in marks if m["time_sec"] >= 0]

    # 弾幕パターン(通常弾幕・スペルカード)のマーカーがあれば、ステージ開始の
    # 間に差し込む(フェーズ49続き。対応済みはth07のみ)。
    pattern_events = label_boss_patterns(parse_boss_patterns(log_path), marks)
    for e in pattern_events:
        t = (e["epoch"] - video_epoch_start) * time_scale
        if t < 0:
            continue
        marks.append({
            "kind": e["kind"],
            "label": e["label"],
            "stage": e["stage"],
            "time_limit_sec": e["limit"],
            "game_frame": e["frame"],
            "time_sec": round(t, 3),
            "timestamp": fmt_timestamp(t),
            "source": "boss_pattern",
        })
    marks.sort(key=lambda m: m["time_sec"])

    base, _ext = os.path.splitext(output_path)
    json_path = f"{base}.chapters.json"
    txt_path = f"{base}.chapters.txt"
    with open(json_path, "w") as f:
        json.dump(marks, f, ensure_ascii=False, indent=2)
    lines = ["00:00 動画開始"]
    lines += [f"{m['timestamp']} {m['label']}" for m in marks]
    with open(txt_path, "w") as f:
        f.write("\n".join(lines) + "\n")
    log(f"ステージ開始時刻を書き出しました: {txt_path}")
    for line in lines:
        log(f"  chapter: {line}")
    return marks


# パターン開始とスペルフラグ変化が「同時」とみなす許容幅(秒)。実測では両者の
# ログ出力差は2ms程度だが、ポーリング間隔(5ms)と負荷変動を見込んで余裕を持たせる。
PATTERN_SPELL_PAIR_SEC = 0.5


def parse_boss_patterns(log_path):
    """MODログから弾幕パターンの開始・ボス撃破イベントを抽出する(フェーズ49続き)。

    - `pattern`行 = 弾幕パターンの制限時間がリセットされた瞬間(=パターン開始)
    - `spell flag=1`行 = スペルカード発動、`flag=0` = スペルカード終了

    パターン開始とスペルフラグ=1がほぼ同時なら「スペルカード」、パターン開始だけなら
    「通常弾幕」。パターン開始を伴わないスペルフラグ=0は「ボス撃破」(スペルカード
    中に倒した場合)とみなす。
    """
    if not os.path.exists(log_path):
        return []
    patterns, flags = [], []
    with open(log_path, errors="replace") as f:
        for line in f:
            m = PATTERN_MARKER_RE.search(line)
            if m:
                limit, prev, frame, epoch_ms = m.groups()
                patterns.append({"epoch": int(epoch_ms) / 1000.0, "limit": int(limit),
                                 "prev": int(prev), "frame": int(frame)})
                continue
            m = SPELL_FLAG_RE.search(line)
            if m:
                flag, frame, epoch_ms = m.groups()
                flags.append({"epoch": int(epoch_ms) / 1000.0, "flag": int(flag),
                              "frame": int(frame)})
    events = []
    used = set()
    for p in patterns:
        kind = "nonspell"
        for i, fl in enumerate(flags):
            if i in used:
                continue
            if abs(fl["epoch"] - p["epoch"]) <= PATTERN_SPELL_PAIR_SEC:
                used.add(i)
                kind = "spell" if fl["flag"] == 1 else "nonspell"
                break
        events.append({"epoch": p["epoch"], "kind": kind, "limit": p["limit"],
                       "frame": p["frame"]})
    for i, fl in enumerate(flags):
        if i in used or fl["flag"] != 0:
            continue
        # パターン開始を伴わないスペル終了 = ボス撃破
        events.append({"epoch": fl["epoch"], "kind": "defeat", "limit": None,
                       "frame": fl["frame"]})
    events.sort(key=lambda e: e["epoch"])
    return events


def label_boss_patterns(events, stage_marks):
    """パターンイベントに「何面の・中ボス/ボスの・何番目の通常弾幕/スペルカード」の
    ラベルを付ける。

    ステージ境界は stage_marks(ステージ開始マーカー)で決め、ステージ内は撃破
    イベントで中ボス/ボスに分割する(1つ目の撃破までが中ボス)。スペルカードの
    **名前**の解決は未対応(reports/49参照)。
    """
    labeled = []
    for e in events:
        stage = 0
        for m in stage_marks:
            if e["epoch"] >= m["epoch"]:
                stage = m["index"]
        e = dict(e, stage=stage)
        labeled.append(e)

    out = []
    by_stage = {}
    for e in labeled:
        by_stage.setdefault(e["stage"], []).append(e)
    for stage, evs in sorted(by_stage.items()):
        seg = 0           # 0=中ボス, 1以降=ボス
        counts = {"nonspell": 0, "spell": 0}
        for e in evs:
            if e["kind"] == "defeat":
                who = "中ボス" if seg == 0 else f"{stage}面ボス"
                out.append(dict(e, label=f"{who} 撃破"))
                seg += 1
                counts = {"nonspell": 0, "spell": 0}
                continue
            counts[e["kind"]] += 1
            who = "中ボス" if seg == 0 else f"{stage}面ボス"
            what = (f"通常{counts['nonspell']}" if e["kind"] == "nonspell"
                    else f"スペルカード{counts['spell']}")
            out.append(dict(e, label=f"{who} {what}"))
    out.sort(key=lambda e: e["epoch"])
    return out

