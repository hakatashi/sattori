"""録画・結合・計測に使う ffmpeg/ffprobe の呼び出し。

映像と音声を別プロセスで録画して後から結合する理由(reports/26)と、`-copyts` による
A/V同期の実測補正(reports/28)は `recording/__init__.py` の冒頭にまとめてある。

**この中のffmpeg呼び出しは全て`-nostdin`必須**(`stdin=subprocess.DEVNULL`と併用)。
`-nostdin`が無いとffmpegが対話的キー操作のためstdinを読もうとし、`timeout`
(`--foreground`無し)配下でプロセスグループがバックグラウンド化されている状態で
標準入力が実端末を指していると、SIGTTINでプロセスグループ全体(ゲーム本体含む)が
停止する(2026-09-15、`recording/vision.py`のgrab_frame()参照)。ここのffprobeは
対話的stdin操作をしないため対象外。
"""
import os
import re
import subprocess

from . import sync_marker
from .timing import NATIVE_FRAME_RATE_HZ, audio_capture_rate_hz, capture_frame_rate_hz, speedup_multiplier


# 等倍録画の音声ビットレート(kbps)。
NATIVE_AUDIO_BITRATE_KBPS = 192

# MPEG-4 AACのサンプルレート表は96000Hzまでしか定義がなく、これを超えるレートを渡すと
# FFmpegは**エラーにせず黙って96000Hzへリサンプルする**。倍速録画の音声は圧縮空間で
# 記録されているため、この頭打ちは等倍へ戻した後の帯域上限をそのまま決めてしまう
# (3倍速なら16.0kHz、4倍速なら12.0kHz)。3倍速以上では可逆のALACへ切り替える
# (touhou-recorder reports/86 §6。Opusは内部48kHz固定なので使ってはならない)。
AAC_MAX_SAMPLE_RATE_HZ = 96000


def _video_encoder_args(gpu_encode):
    """映像エンコーダの引数。

    GPUワーカー(`recording.timing.gpu_worker()`)ではNVENC(h264_nvenc)へオフロードする。
    x11grab+libx264はキャプチャとエンコードでCPUを奪い合い、倍速録画ではゲーム本体の
    スレッドと競合して処理落ちする(g6f.xlargeの2倍速で重複率10〜11%、NVENCで0.8%、
    touhou-recorder reports/84・85)。同じcq/crf値でもNVENCはビットレートが2.7〜3倍に
    なるため、明示的なレート制御でlibx264 crf18相当に近づける(reports/84)。
    """
    if gpu_encode:
        return ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr",
                "-cq", "23", "-b:v", "5M", "-maxrate", "6M", "-pix_fmt", "yuv420p"]
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"]


def audio_intermediate_extension(time_scale):
    """録音中間ファイルの拡張子。

    倍速録画は**AACではなくPCM(mov)で録音する**。libavcodecのAACエンコーダは88200/96000Hzの
    場合に`-copyts`で保持した絶対wallclock秒のstart_timeを0にリセットしてしまい
    (コンテナによらず再現、エンコーダ側の問題)、A/V同期補正が完全に破綻する
    (touhou-recorder reports/85)。AAC/ALACへの変換はmux時に行う。
    """
    return ".audio.mov" if audio_capture_rate_hz(time_scale) else ".audio.m4a"


def audio_encode_args(time_scale):
    """mux時の音声の引数。

    - 等倍: 録音時点でAAC 192kなので再エンコードせずコピーする
    - 倍速録画(録音レートがAACの上限以内、2倍速): AAC + 倍率分のビットレート + `-cutoff`。
      FFmpegのAACエンコーダは`-cutoff`未指定時、1チャンネルあたりのビットレートだけから
      **絶対周波数**で帯域を決める(192k/2chなら約19.3kHz)。倍速録画の音声は圧縮空間に
      あるため、そのままだと等倍へ戻した後に9.7kHz以上が失われる(reports/86 §3)。
      ビットレートも倍率分上げる(同じ内容を1/Nの実時間で記録するため)。
    - 倍速録画(録音レートがAACの上限超え、3倍速以上): ALAC(可逆)
    """
    capture_rate = audio_capture_rate_hz(time_scale)
    if capture_rate is None:
        return ["-c:a", "copy"]
    if capture_rate > AAC_MAX_SAMPLE_RATE_HZ:
        return ["-c:a", "alac"]
    bitrate = round(NATIVE_AUDIO_BITRATE_KBPS * speedup_multiplier(time_scale))
    return ["-c:a", "aac", "-b:a", f"{bitrate}k", "-cutoff", str(capture_rate // 2)]


def build_video_ffmpeg_cmd(config, x, y, w, h, video_output, side_stream_path=None, *,
                           time_scale=1.0, gpu_encode=False, window_id=None):
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

    `side_stream_path`(`config.poll_side_stream`使用時のみ)を指定すると、
    `-filter_complex`の`split`で本番録画用の出力とは別に、8fpsの静止画連番出力
    (`-f image2 -update 1`で同一ファイルへ継続上書き)を追加する。終了検知・進捗
    スクショ用の定期ポーリング(`vision.grab_frame()`)が毎回新規ffmpegプロセスを
    起動して本番のx11grabキャプチャと競合し、周期的なコマ落ちを起こす問題への対処
    (GPU描画・高解像度のth06ncで顕在化、touhou-recorder reports/81 §9)。
    未指定時は従来通りのコマンド文字列と完全に一致する。

    倍速録画(`time_scale`<1、Issue #288)ではキャプチャのフレームレート自体を60×倍率へ
    上げる(`recording.timing.capture_frame_rate_hz()`)。`window_id`を指定すると座標では
    なくウィンドウID基準で取り込む(`GameConfig.capture_by_window_id`)。`gpu_encode`で
    NVENCへオフロードする(`_video_encoder_args()`)。
    """
    frame_rate = capture_frame_rate_hz(time_scale)
    base_cmd = [
        "ffmpeg", "-y", "-nostdin", "-copyts",
        "-f", "x11grab", "-draw_mouse", "0", "-video_size", f"{w}x{h}", "-framerate", str(frame_rate),
    ]
    if window_id:
        base_cmd += ["-window_id", str(window_id), "-i", config.display]
    else:
        base_cmd += ["-i", f"{config.display}+{x},{y}"]
    output_args = []
    if frame_rate > NATIVE_FRAME_RATE_HZ:
        # 60fps超のframerateをx11grabに指定すると、ffmpeg既定のcfr変換がタイムスタンプ
        # 処理を誤り、r_frame_rateが"1000000/1"のような異常値になりnb_framesも理論値の
        # 数倍に膨れ上がる(touhou-recorder reports/84・85)。-vsync 0(パススルー)で
        # 入力フレームをそのまま素通しすると正しいフレーム数で出力される。
        output_args += ["-vsync", "0"]
    output_args += _video_encoder_args(gpu_encode)
    if not side_stream_path:
        return base_cmd + output_args + [video_output]
    return base_cmd + [
        "-filter_complex", "[0:v]split=2[vmain][vpoll];[vpoll]fps=8[vpollout]",
        "-map", "[vmain]", *output_args, video_output,
        "-map", "[vpollout]", "-f", "image2", "-update", "1", "-flush_packets", "1",
        "-qscale:v", "5", side_stream_path,
    ]


def build_audio_ffmpeg_cmd(config, audio_output, *, time_scale=1.0):
    """音声のみを録画するffmpegコマンド(別プロセス、reports/26参照)。
    `-copyts`はbuild_video_ffmpeg_cmd()と同じ理由(reports/28参照)。

    倍速録画(Issue #288)では、ジョブ専用シンク(`pulse.job_sink()`が倍率ぶんの高レートで
    作成する)を同じレートで録り、PCMのまま書き出す(`audio_intermediate_extension()`)。
    """
    capture_rate = audio_capture_rate_hz(time_scale)
    if capture_rate is None:
        return [
            "ffmpeg", "-y", "-nostdin", "-copyts", "-f", "pulse", "-i", config.pulse_source,
            "-c:a", "aac", "-b:a", f"{NATIVE_AUDIO_BITRATE_KBPS}k", audio_output,
        ]
    return [
        "ffmpeg", "-y", "-nostdin", "-copyts", "-f", "pulse", "-sample_rate", str(capture_rate),
        "-i", config.pulse_source, "-c:a", "pcm_s16le", audio_output,
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


def _run_mux(video_path, audio_path, output_path, env, delta, time_scale, log):
    """`delta`(音声の先頭 − 映像の先頭、秒)だけずらして結合する。成否をboolで返す。"""
    video_offset = -delta if delta < 0 else 0.0
    audio_offset = delta if delta > 0 else 0.0
    cmd = ["ffmpeg", "-y", "-nostdin"]
    if video_offset:
        cmd += ["-itsoffset", f"{video_offset:.6f}"]
    cmd += ["-i", video_path]
    if audio_offset:
        cmd += ["-itsoffset", f"{audio_offset:.6f}"]
    cmd += ["-i", audio_path, "-c:v", "copy", *audio_encode_args(time_scale), "-shortest", output_path]
    log(f"mux実行: {' '.join(cmd)}")
    result = subprocess.run(cmd, env=env, stdin=subprocess.DEVNULL, capture_output=True)
    if result.returncode != 0:
        log(f"WARNING: mux失敗 (returncode={result.returncode}): {result.stderr[-2000:].decode(errors='replace')}")
    return result.returncode == 0


def mux_audio_video(video_path, audio_path, output_path, env, log=print, *,
                    time_scale=1.0, marker_log_path=None):
    """映像・音声を結合する(映像は再エンコードなし)。

    x11grab(映像)とpulse(音声)は起動から実際にキャプチャを開始するまでの初期化
    レイテンシが異なり(音声側が数百ms〜1秒超遅い、touhou-recorder reports/28)、
    素朴に結合すると音声が映像より数百ms先行して聴こえる音ズレが生じる。
    build_video_ffmpeg_cmd/build_audio_ffmpeg_cmd が付与する`-copyts`で保持した
    絶対start_time(wallclockベース、epoch秒)の差分を実測し、遅く始まった側に
    `-itsoffset`を与えることでハードコードされた定数を使わずに毎回自動補正する。

    ただしstart_timeの差には、pulseのレイテンシの差し引き方とWineの出力遅延に起因する
    系統誤差(等倍でも+90〜+190ms)が残る。MODが鳴らした同期マーカー
    (`recording/sync_marker.py`、reports/88)が`marker_log_path`(MODログ)に記録されて
    いて、音声からも検出できればそちらで位置を決め、mux後に残差を検証して許容値を
    超えていれば1回だけmuxし直す。見つからなければ従来どおりstart_timeの差で補正する。
    """
    v_start = ffprobe_start_time(video_path, env)
    a_start = ffprobe_start_time(audio_path, env)
    if v_start is None or a_start is None:
        log("WARNING: -copytsのstart_time取得に失敗したため、A/V同期補正をスキップします")
        return _run_mux(video_path, audio_path, output_path, env, 0.0, time_scale, log)

    delta = a_start - v_start
    log(
        f"A/V同期補正(start_time): video_start={v_start:.3f} audio_start={a_start:.3f} "
        f"delta={delta:+.3f}s"
    )

    marker = sync_marker.parse_marker_log(marker_log_path, log=log) if marker_log_path else None
    if marker is None:
        if marker_log_path:
            log("WARNING: MODログに同期マーカーの記録が無いため、start_timeの差で補正します")
    else:
        t_audio, ratio = sync_marker.find_marker_time(audio_path, marker, env=env)
        if t_audio is None or ratio < sync_marker.MIN_PEAK_RATIO:
            log(f"WARNING: 音声から同期マーカーを検出できませんでした (peak_ratio={ratio:.1f})。"
                "start_timeの差で補正します")
            marker = None
        else:
            marker_delta = (marker["epoch"] - t_audio) - v_start
            log(
                f"A/V同期補正(同期マーカー): marker_epoch={marker['epoch']:.6f} "
                f"音声上の位置={t_audio:.4f}s peak_ratio={ratio:.0f} delta={marker_delta:+.4f}s "
                f"(start_time方式との差 {marker_delta - delta:+.4f}s)"
            )
            delta = marker_delta

    ok = _run_mux(video_path, audio_path, output_path, env, delta, time_scale, log)
    if not ok or marker is None or not os.path.exists(output_path):
        return ok

    residual, ratio = sync_marker.verify_output(output_path, marker, v_start, env=env)
    if residual is None:
        log(f"WARNING: mux後の同期マーカー検証に失敗しました (peak_ratio={ratio:.1f})")
        return ok
    log(f"同期マーカー検証(mux後): 残差={residual * 1000:+.1f}ms peak_ratio={ratio:.0f}")
    if abs(residual) <= sync_marker.RESIDUAL_TOLERANCE_SEC:
        return ok
    delta -= residual
    log(f"残差が許容値を超えたため再muxします (delta={delta:+.4f}s)")
    ok = _run_mux(video_path, audio_path, output_path, env, delta, time_scale, log)
    if ok:
        residual, _ratio = sync_marker.verify_output(output_path, marker, v_start, env=env)
        if residual is not None:
            log(f"同期マーカー検証(再mux後): 残差={residual * 1000:+.1f}ms")
    return ok


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
                "ffmpeg", "-nostdin", "-i", video_path, "-ss", str(start_sec), "-t", str(duration_sec),
                "-vf", "mpdecimate", "-vsync", "0", "-an", "-f", "null", "-",
            ],
            stdin=subprocess.DEVNULL, capture_output=True, text=True,
        )
        matches = re.findall(r"frame=\s*(\d+)", decimate_result.stderr)
        if not matches:
            return None
        unique_frames = int(matches[-1])

        return round(max(0.0, (1 - unique_frames / total_frames) * 100), 1)
    except (subprocess.CalledProcessError, ValueError, ZeroDivisionError, OSError):
        return None
