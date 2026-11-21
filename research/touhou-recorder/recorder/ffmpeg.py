"""録画・結合・重複フレーム率計測に使う ffmpeg/ffprobe の呼び出し。

**映像と音声は既定で別プロセスで録画する。** フェーズ26で、AWS環境ではx11grab(映像)と
pulse(音声)を1つのffmpegプロセスで同時に取り込むと、th08の描画タイミングがffmpeg内部の
A/V同期に律速されて重複フレーム率が85%超に悪化することを特定した。別プロセスにすれば
同じ音声を録りながらでも映像は正常(2%前後)になる(reports/26)。

その副作用として、両プロセスの起動から実際にキャプチャを開始するまでの初期化レイテンシが
異なり(pulseの方がx11grabより数百ms〜1秒超遅い)、素朴に結合すると音声が映像より数百ms
先行して聴こえる音ズレが生じる(th08実機で約700ms、reports/28)。両ffmpegに`-copyts`を
付与して実際の絶対キャプチャ開始時刻(wallclockベースのepoch秒)を出力ファイルの
start_timeとして保持し、`mux_audio_video()`がその差分を**毎回実測して**遅く始まった側に
`-itsoffset`を与えることで補正する(ハードコードされた定数は使わない)。
"""
import os
import subprocess

from . import sync_marker
from .config import DOUBLESPEED_SINK_NAME_PREFIX, PULSE_SOURCE, REPO
from .log import log
from .timing import AUDIO_CAPTURE_RATE_HZ, MENU_TIME_SCALE, NATIVE_AUDIO_RATE_HZ, NATIVE_FRAME_RATE_HZ
from .vision import FRAME_H, FRAME_W, POLL_STREAM_FPS

# 倍速録画(MENU_TIME_SCALE<1.0、issue #1)では、x11grabのキャプチャフレームレート
# 自体を60fps固定にしたままだと、ゲーム側は`FPS_LIMIT_TARGET_HZ`相当の速さで
# 描画しているのに半分程度しか捉えられず、後処理でsetptsにより時間を引き伸ばしても
# 失われた情報は戻らない(復元後の実効fpsが本来の半分以下になる不具合、reports/85)。
# キャプチャのframerate自体もゲームの描画速度に合わせて引き上げる。
# 低速録画(MENU_TIME_SCALE>1.0)はゲーム進行が遅くなるだけで60fpsのままで全フレーム
# を捉えられているため、この調整は不要(60fps固定のまま)。
CAPTURE_FRAME_RATE_HZ = (
    round(NATIVE_FRAME_RATE_HZ / MENU_TIME_SCALE) if 0 < MENU_TIME_SCALE < 1.0
    else round(NATIVE_FRAME_RATE_HZ)
)
# 検証用の上書き。描画fpsがキャプチャfpsの整数分の1でない低速録画(40Hz等)は、等倍へ戻す際の
# 間引きでフレームが欠けるため、描画fpsの整数倍のキャプチャを試せるようにする(reports/91)。
if os.environ.get("CAPTURE_FRAME_RATE_HZ"):
    CAPTURE_FRAME_RATE_HZ = int(os.environ["CAPTURE_FRAME_RATE_HZ"])

# 音声をAACへエンコードする際のビットレート(kbps)と符号化帯域(Hz)。
#
# FFmpegのネイティブAACエンコーダは`-cutoff`未指定時、`libavcodec/aacenc.c`で
# 「1チャンネルあたりのビットレート」だけから符号化帯域を決める(192kbps/2chなら
# 約19.3kHz)。この帯域は**絶対周波数**であり、サンプルレートには連動しない
# (`FFMIN3(bandwidth, 22000, sample_rate / 2)`という上限があるだけ)。
#
# 倍速録画では音声が「テープの早回し」と同じく圧縮された状態で記録されるため、
# 88200Hz(2倍速)の録音に対する19.3kHzは、等倍へ戻すと9.66kHzでしかない。
# reports/85 §11.7で「録音シンクを88200Hz化しても高域が戻らない」と観測されたのは
# これが原因で、Wine側の問題(reports/86 §2)とほぼ同じカットオフ値になるため
# 片方だけ直しても症状が変わらないように見えていた(reports/86 §3)。
#
# 対策として倍速時は`-cutoff`に録音レートのナイキスト周波数を明示する。あわせて、
# 倍速録画は「同じゲーム内容を1/N の実時間で記録したもの」でビット数が不足するため、
# ビットレートも倍率分スケールする(2倍速なら384k。実測SNRは192k=37.6dB、
# 384k=46.1dB、reports/86 §3.2)。
NATIVE_AUDIO_BITRATE_KBPS = 192
AUDIO_BITRATE_KBPS = (
    round(NATIVE_AUDIO_BITRATE_KBPS / MENU_TIME_SCALE) if 0 < MENU_TIME_SCALE < 1.0
    else NATIVE_AUDIO_BITRATE_KBPS
)

# MPEG-4 AACのサンプルレート表は96000Hzまでしか定義がなく、これを超えるレートを
# 渡すとFFmpegは**エラーにせず黙って96000Hzへリサンプルする**。倍速録画の音声は
# 圧縮空間で記録されているため、この頭打ちは復元後の帯域上限をそのまま決めてしまう
# (ナイキスト48000Hzを倍率で割った値: 3倍速なら16.0kHz、4倍速なら12.0kHz)。
#
# 2倍速(88200Hz)はAACの範囲内に収まり、復元後22.05kHz=元素材(44100Hz)の全帯域を
# 保持できるのでAACのままでよい。3倍速以上では可逆のALACへ切り替える(mp4に
# そのまま格納でき、`scripts/47_descale_th20_slowmo.py`での復元時に通常のAACへ
# 変換されるため、最終成果物の互換性は変わらない)。reports/86 §6。
AAC_MAX_SAMPLE_RATE_HZ = 96000


def audio_encode_args():
    """音声エンコードの引数。

    - ネイティブ/低速録画: 従来通りAAC 192k(既定の帯域制限のまま)
    - 倍速録画(録音レートがAACの上限以内): AAC + 倍率分のビットレート + `-cutoff`
    - 倍速録画(録音レートがAACの上限超え): ALAC(可逆)
    """
    if AUDIO_CAPTURE_RATE_HZ == NATIVE_AUDIO_RATE_HZ:
        return ["-c:a", "aac", "-b:a", f"{AUDIO_BITRATE_KBPS}k"]
    if AUDIO_CAPTURE_RATE_HZ > AAC_MAX_SAMPLE_RATE_HZ:
        return ["-c:a", "alac"]
    return ["-c:a", "aac", "-b:a", f"{AUDIO_BITRATE_KBPS}k",
            "-cutoff", str(AUDIO_CAPTURE_RATE_HZ // 2)]


def _audio_input_args(config):
    """pulse入力の引数一式。倍速録画時は高レート専用シンク(`recorder.instance.
    ensure_audio_sink()`が作成)のmonitorを`-sample_rate`付きで指定する。
    ネイティブ/低速時は既定のauto_nullのまま何も指定しない(明示するとauto_null
    既定の44100Hzから不要なリサンプリングが発生し、既存タイトルの挙動が変わって
    しまうため、既存動作を完全に維持する)。"""
    if AUDIO_CAPTURE_RATE_HZ != NATIVE_AUDIO_RATE_HZ:
        source = f"{DOUBLESPEED_SINK_NAME_PREFIX}_{config.game_id}.monitor"
        return ["-f", "pulse", "-sample_rate", str(AUDIO_CAPTURE_RATE_HZ), "-i", source]
    return ["-f", "pulse", "-i", PULSE_SOURCE]


def build_video_ffmpeg_cmd(config, options, geometry, poll_raw_path=None, window_id=None):
    """映像録画用のffmpegコマンドを組み立てる。

    filter_complexの構成は以下の順で積む(いずれも任意):

      1. `poll_side_stream`: splitして160x120 grayのサブ出力を生やす(終了検知用、reports/81)
      2. ウォーターマーク: 右下へoverlay
      3. 720pアップスケール

    `--muxed-audio`指定時のみpulse入力をこのコマンドに相乗りさせる(旧来方式)。
    """
    x, y, w, h = geometry
    cmd = ["ffmpeg", "-y"]
    if options.separate_audio:
        # 音ズレ対策。x11grab/pulseそれぞれのwallclockベースの絶対pts(epoch秒)をそのまま
        # 出力ファイルのstart_timeに残し、mux時に実測した差分だけ補正する(reports/28)。
        cmd += ["-copyts"]
    cmd += [
        "-f", "x11grab", "-draw_mouse", "0", "-video_size", f"{w}x{h}",
        "-framerate", str(CAPTURE_FRAME_RATE_HZ),
    ]
    if window_id:
        # ウィンドウ基準で取り込む(GameConfig.capture_by_window_id、reports/89)
        cmd += ["-window_id", str(window_id), "-i", config.display]
    else:
        cmd += ["-i", f"{config.display}+{x},{y}"]
    if options.inline_audio:
        cmd += _audio_input_args(config)
    # inline音声入力の有無で後続のwatermark入力インデックスが1つずれる
    wm_input_idx = 2 if options.inline_audio else 1

    filters = []
    video_label = "0:v"
    if poll_raw_path:
        filters.append("[0:v]split=2[vmain][vpollsrc]")
        filters.append(
            f"[vpollsrc]fps={POLL_STREAM_FPS:g},"
            f"scale={FRAME_W}:{FRAME_H},format=gray[vpollout]"
        )
        video_label = "vmain"
    if options.watermark:
        watermark_w = min(options.watermark_width, w // 2)
        cmd += ["-c:v", "libvpx-vp9", "-i", options.watermark]
        filters.append(f"[{wm_input_idx}:v]scale={watermark_w}:-1[wm]")
        filters.append(f"[{video_label}][wm]overlay=x=W-w-8:y=H-h-8:eof_action=pass[ov]")
        video_label = "ov"
    if options.upscale_720p:
        target_height = 720
        target_width = round(w * target_height / h / 2) * 2
        filters.append(f"[{video_label}]scale={target_width}:{target_height}:flags=lanczos[v720]")
        video_label = "v720"
    if filters:
        cmd += ["-filter_complex", ";".join(filters), "-map", f"[{video_label}]"]
        if options.inline_audio:
            cmd += ["-map", "1:a"]
    if CAPTURE_FRAME_RATE_HZ > NATIVE_FRAME_RATE_HZ:
        # 倍速録画(issue #1)で60fps超のframerateをx11grabに指定すると、ffmpeg既定の
        # cfr変換(-vsync既定動作)がタイムスタンプ処理を誤り、r_frame_rateが
        # "1000000/1"のような異常値になりnb_framesも理論値の数倍に膨れ上がる不具合が
        # 実機検証で見つかった(reports/84の合成テスト環境での既知の限界が実際の
        # 東方ゲーム画面でも再現、reports/85)。-vsync 0(パススルー)で入力フレームを
        # そのまま素通しすると正しいフレーム数で出力されることを確認済み。
        cmd += ["-vsync", "0"]
    if options.gpu_encode:
        # reports/84: 同cq/crf値でもNVENCはビットレートが2.7〜3倍程度高くなるため、
        # 明示的なレート制御(-rc vbr -cq <値> -b:v <目標> -maxrate <上限>)でlibx264
        # crf18相当のファイルサイズに近づける。
        cmd += ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr",
                "-cq", "23", "-b:v", "5M", "-maxrate", "6M", "-pix_fmt", "yuv420p"]
    else:
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"]
    if options.inline_audio:
        cmd += ["-c:a", "aac", "-b:a", "192k"]
    cmd += [options.video_target]
    if poll_raw_path:
        cmd += [
            "-map", "[vpollout]", "-f", "rawvideo", "-pix_fmt", "gray",
            # 出力バッファに溜めずに毎フレーム書き出させる(読み側が同じフレームを何度も
            # 掴むのを避けるため)。それでも遅れうるので読み側でもフレーム番号が進んだ
            # ことを確認する(vision.read_poll_frame)。
            "-flush_packets", "1", poll_raw_path,
        ]
    return cmd


def build_audio_ffmpeg_cmd(config, options):
    """音声のみを録画するffmpegコマンド(別プロセス、reports/26)。

    倍速録画時は`AUDIO_CAPTURE_RATE_HZ`(88200/96000Hz等)で高レート録音する
    (reports/85)。この際**AACではなくPCM(pcm_s16le)で録音する**必要がある。
    libavcodecのAACエンコーダは88200/96000Hzの場合に`-copyts`で保持した絶対
    wallclock秒のstart_timeを0にリセットしてしまう不具合があり(mp4/m4a/mkv
    いずれのコンテナでも再現、コンテナではなくエンコーダ側の問題と実機検証で
    特定)、A/V同期補正が完全に破綻する。PCMのまま録音すればこの問題を回避でき、
    AACへの変換は`mux_audio_video()`側で(絶対epoch秒を扱わない通常のエンコードとして)
    行う。ネイティブ/低速時は従来通りAACへ直接エンコードする(既存タイトルの
    挙動を維持するため)。
    """
    cmd = ["ffmpeg", "-y", "-copyts"] + _audio_input_args(config)
    if AUDIO_CAPTURE_RATE_HZ != NATIVE_AUDIO_RATE_HZ:
        cmd += ["-c:a", "pcm_s16le"]
    else:
        cmd += audio_encode_args()
    cmd += [options.audio_target]
    return cmd


def ffprobe_start_time(path, env):
    """-copytsで保持した絶対wallclock秒(epoch秒)のstart_timeを取得する。取得失敗時はNone。"""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=start_time",
             "-of", "default=nw=1:nk=1", path],
            env=env, capture_output=True, text=True, timeout=10,
        )
        return float(out.stdout.strip())
    except (subprocess.SubprocessError, ValueError, OSError):
        return None


def _run_mux(video_path, audio_path, output_path, env, delta):
    """`delta`(音声の先頭 − 映像の先頭、秒)だけずらして結合する。"""
    video_offset = -delta if delta < 0 else 0.0
    audio_offset = delta if delta > 0 else 0.0
    mux_cmd = ["ffmpeg", "-y"]
    if video_offset:
        mux_cmd += ["-itsoffset", f"{video_offset:.6f}"]
    mux_cmd += ["-i", video_path]
    if audio_offset:
        mux_cmd += ["-itsoffset", f"{audio_offset:.6f}"]
    mux_cmd += ["-i", audio_path, "-c:v", "copy"]
    if AUDIO_CAPTURE_RATE_HZ != NATIVE_AUDIO_RATE_HZ:
        # 倍速録画時の音声はPCMのまま録音している(build_audio_ffmpeg_cmd()の理由に
        # よりmux時に変換する)。`-cutoff`を明示しないと符号化帯域が約19.3kHzに
        # 制限され、等倍へ戻したときに9.7kHz以上が失われる(reports/86 §3)。
        mux_cmd += audio_encode_args()
    else:
        mux_cmd += ["-c:a", "copy"]
    mux_cmd += ["-shortest", output_path]
    log(f"mux実行: {' '.join(mux_cmd)}")
    mux = subprocess.run(mux_cmd, env=env, capture_output=True)
    if mux.returncode != 0:
        log(f"WARNING: mux失敗 (returncode={mux.returncode}): "
            f"{mux.stderr[-2000:].decode(errors='replace')}")
    return video_offset


def mux_audio_video(video_path, audio_path, output_path, env, marker_log_path=None):
    """別録りした映像・音声を(映像は再エンコードなしで)結合する。

    音声の位置は、MODが鳴らした同期マーカー(`recorder/sync_marker.py`、reports/88)が
    見つかればそれで決める。見つからなければ従来どおり両ファイルの`-copyts`の
    start_timeの差で決める(reports/28)。

    戻り値は「mux後の動画のt=0に対応する絶対時刻(epoch秒)」で、ステージ開始時刻を
    動画内の秒数へ変換する際の基準に使う(`recorder/chapters.py`)。start_timeが
    取得できなかった場合はNone。
    """
    v_start = ffprobe_start_time(video_path, env)
    a_start = ffprobe_start_time(audio_path, env)
    if v_start is None or a_start is None:
        log("WARNING: -copytsのstart_time取得に失敗したため、A/V同期補正をスキップします")
        _run_mux(video_path, audio_path, output_path, env, 0.0)
        return v_start

    delta = a_start - v_start
    log(f"A/V同期補正(start_time): video_start={v_start:.3f} audio_start={a_start:.3f} "
        f"delta={delta:+.3f}s")

    marker = sync_marker.parse_marker_log(marker_log_path) if marker_log_path else None
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
            true_a_start = marker["epoch"] - t_audio
            marker_delta = true_a_start - v_start
            log(f"A/V同期補正(同期マーカー): marker_epoch={marker['epoch']:.6f} "
                f"音声上の位置={t_audio:.4f}s peak_ratio={ratio:.0f} "
                f"delta={marker_delta:+.4f}s (start_time方式との差 "
                f"{marker_delta - delta:+.4f}s)")
            delta = marker_delta

    video_offset = _run_mux(video_path, audio_path, output_path, env, delta)

    if marker is not None and os.path.exists(output_path):
        residual, ratio = sync_marker.verify_output(output_path, marker, v_start, env=env)
        if residual is None:
            log(f"WARNING: mux後の同期マーカー検証に失敗しました (peak_ratio={ratio:.1f})")
        else:
            log(f"同期マーカー検証(mux後): 残差={residual * 1000:+.1f}ms peak_ratio={ratio:.0f}")
            if abs(residual) > sync_marker.RESIDUAL_TOLERANCE_SEC:
                delta -= residual
                log(f"残差が許容値を超えたため再muxします (delta={delta:+.4f}s)")
                video_offset = _run_mux(video_path, audio_path, output_path, env, delta)
                residual, ratio = sync_marker.verify_output(output_path, marker, v_start, env=env)
                if residual is not None:
                    log(f"同期マーカー検証(再mux後): 残差={residual * 1000:+.1f}ms")

    # 映像側を遅らせた場合、mux後の動画のt=0は映像の先頭より video_offset 秒前。
    return v_start - video_offset


def measure_duplicate_rate(video_path, start_sec, duration_sec):
    """指定区間の重複フレーム率(%)を計測する。計測できなければNone。

    Noneは「動画が空か壊れている」ことを意味するので、**呼び出し側はこれを
    「異常なし」と扱ってはならない**(フェーズ81、x11grabがウィンドウ画面外で失敗した際に
    1フレームも録れていない録画が成功扱いになる不具合が実際に発生した)。
    """
    result = subprocess.run(
        ["bash", f"{REPO}/scripts/measure_duplicate_frame_rate.sh",
         video_path, str(start_sec), str(duration_sec)],
        capture_output=True, text=True,
    )
    for line in result.stdout.splitlines():
        if "duplicate_rate=" in line:
            try:
                return float(line.split("duplicate_rate=")[1].rstrip("%"))
            except ValueError:
                return None
    return None
