"""録画・結合・計測に使う ffmpeg/ffprobe の呼び出し。

映像と音声を別プロセスで録画して後から結合する理由(reports/26)と、`-copyts` による
A/V同期の実測補正(reports/28)は `recording/__init__.py` の冒頭にまとめてある。
"""
import re
import subprocess


def build_video_ffmpeg_cmd(config, x, y, w, h, video_output):
    """映像のみを録画するffmpegコマンド(音声は別プロセス、reports/26参照)。
    `-copyts`で実際の絶対キャプチャ開始時刻(wallclockベースのepoch秒)を出力ファイルの
    start_timeとして保持する。mux時にこれを使ってA/V同期を補正する(reports/28参照)。

    ウォーターマークはこのコマンドでは合成しない。x11grab の生ptsは wallclock
    ベース(実epoch秒)で `-copyts` により無加工のまま filtergraph に渡るため、
    ほぼ0起点のウォーターマーク動画(ファイル入力)と overlay filter 内で
    フレーム同期が全く噛み合わず、overlay の `eof_action=pass` が即座に発動して
    ウォーターマークが一切合成されない不具合が本番のth08録画で発覚した。
    ウォーターマークは convert.py 側(`-copyts`を使わない通常のファイル入力
    同士の合成で、かつどのみち720p変換のために既に発生する再エンコード1回に
    相乗りできる)で行う。
    """
    return [
        "ffmpeg", "-y", "-copyts",
        "-f", "x11grab", "-draw_mouse", "0", "-video_size", f"{w}x{h}", "-framerate", "60",
        "-i", f"{config.display}+{x},{y}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        video_output,
    ]


def build_audio_ffmpeg_cmd(config, audio_output):
    """音声のみを録画するffmpegコマンド(別プロセス、reports/26参照)。
    `-copyts`はbuild_video_ffmpeg_cmd()と同じ理由(reports/28参照)。"""
    return [
        "ffmpeg", "-y", "-copyts", "-f", "pulse", "-i", config.pulse_source,
        "-c:a", "aac", "-b:a", "192k", audio_output,
    ]


def ffprobe_start_time(path, env):
    """-copytsで保持した絶対wallclock秒(epoch秒)のstart_timeを取得する。取得失敗時はNoneを返す。"""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=start_time",
             "-of", "default=nw=1:nk=1", path],
            env=env, capture_output=True, text=True, timeout=10,
        )
        return float(out.stdout.strip())
    except (subprocess.SubprocessError, ValueError, OSError):
        return None


def mux_audio_video(video_path, audio_path, output_path, env, log=print):
    """映像・音声を結合する(再エンコードなし)。

    x11grab(映像)とpulse(音声)は起動から実際にキャプチャを開始するまでの初期化
    レイテンシが異なり(音声側が数百ms〜1秒超遅い、touhou-recorder reports/28)、
    素朴に結合すると音声が映像より数百ms先行して聴こえる音ズレが生じる。
    build_video_ffmpeg_cmd/build_audio_ffmpeg_cmd が付与する`-copyts`で保持した
    絶対start_time(wallclockベース、epoch秒)の差分を実測し、遅く始まった側に
    `-itsoffset`を与えることでハードコードされた定数を使わずに毎回自動補正する。
    """
    video_offset = 0.0
    audio_offset = 0.0
    v_start = ffprobe_start_time(video_path, env)
    a_start = ffprobe_start_time(audio_path, env)
    if v_start is not None and a_start is not None:
        delta = a_start - v_start
        if delta > 0:
            audio_offset = delta
        elif delta < 0:
            video_offset = -delta
        log(
            f"A/V同期補正: video_start={v_start:.3f} audio_start={a_start:.3f} "
            f"delta={delta:+.3f}s (video_offset={video_offset:.3f}s audio_offset={audio_offset:.3f}s)"
        )
    else:
        log("WARNING: -copytsのstart_time取得に失敗したため、A/V同期補正をスキップします")

    cmd = ["ffmpeg", "-y"]
    if video_offset:
        cmd += ["-itsoffset", f"{video_offset:.6f}"]
    cmd += ["-i", video_path]
    if audio_offset:
        cmd += ["-itsoffset", f"{audio_offset:.6f}"]
    cmd += ["-i", audio_path, "-c", "copy", "-shortest", output_path]
    log(f"mux実行: {' '.join(cmd)}")
    result = subprocess.run(cmd, env=env, capture_output=True)
    if result.returncode != 0:
        log(f"WARNING: mux失敗 (returncode={result.returncode}): {result.stderr[-2000:].decode(errors='replace')}")
    return result.returncode == 0


def measure_duplicate_rate(video_path, start_sec, duration_sec):
    """録画動画の指定区間について、mpdecimateフィルタで重複フレーム率(%)を計測する。
    ウィンドウ再作成等による処理落ち(reports/12・13・22)の事後検知に使う。
    計測に失敗した場合はNoneを返す。"""
    try:
        probe_out = subprocess.run(
            [
                "ffprobe", "-v", "error", "-select_streams", "v:0",
                "-read_intervals", f"{start_sec}%+{duration_sec}",
                # ffmpeg 6.x(Ubuntu 24.04 のワーカーイメージが導入するバージョン)では
                # 旧称の `pkt_pts_time` は出力されなくなっている(空文字列を返し続け、
                # 常にNoneになる不具合を実機テストで確認した)。現行の `pts_time` を使う。
                "-show_entries", "frame=pts_time", "-of", "csv=p=0", video_path,
            ],
            capture_output=True, text=True, check=True,
        ).stdout
        total_frames = len([line for line in probe_out.splitlines() if line.strip()])
        if total_frames == 0:
            return None

        decimate_result = subprocess.run(
            [
                "ffmpeg", "-i", video_path, "-ss", str(start_sec), "-t", str(duration_sec),
                "-vf", "mpdecimate", "-vsync", "0", "-an", "-f", "null", "-",
            ],
            capture_output=True, text=True,
        )
        matches = re.findall(r"frame=\s*(\d+)", decimate_result.stderr)
        if not matches:
            return None
        unique_frames = int(matches[-1])

        return round(max(0.0, (1 - unique_frames / total_frames) * 100), 1)
    except (subprocess.CalledProcessError, ValueError, ZeroDivisionError, OSError):
        return None
