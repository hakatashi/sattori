#!/usr/bin/env python3
"""録画結果を「ユーザーへ配信する1本」へ変換する後処理(Sattori ワーカー)。

**録画後の再エンコードは、どのタイトル・どの録画速度でもこの1パスだけ**。次の3つを
1つの ffmpeg 呼び出し(1回の filter_complex)にまとめてある:

  1. 等倍への戻し(低速録画、Issue #68): 映像のPTSを圧縮し、音声のサンプルレートを
     逆比率でリサンプルする。遅回しを早回しで戻す可逆変換なので、速度・ピッチとも
     劣化なく復元できる(touhou-recorder reports/47)。
  2. 解像度合わせ: **720pに満たない録画だけ引き上げる**。既に720p以上の録画
     (th20の1280x960)はそのまま通す —— 後述。
  3. ウォーターマークの合成: x11grab録画時ではなくここで行う。録画時は`-copyts`で
     生ptsがwallclock(実epoch秒)のまま filtergraph に渡るため、ほぼ0起点の
     ウォーターマーク動画とフレーム同期が噛み合わず overlay が不発になる
     (本番のth08録画で発覚)。完成済みファイル入力同士のここでは正しく機能する。

## なぜ720p「以上」にはしないのか

720p版が存在する理由は「th07(640x480)のような低解像度録画は、そのまま YouTube へ
上げると60fpsとして認識されない」ことへの対策(reports/21)であり、**元から720p以上ある
録画には当てはまらない**。th20は内部描画解像度が960p相当(1280x960)なので、高さ720pxへ
「合わせる」と960x720への縮小になり、主要ダウンロード導線がユーザーをわざわざ低い
解像度へ誘導してしまう。

出力解像度をアスペクト比を保って決めるのは共通で、「720pという呼称に引きずられて
1280x720(16:9)へ固定すると4:3コンテンツが横方向だけ引き伸ばされて歪む」(reports/21)
という制約も変わらない。

## 出力が1本になる場合と2本になる場合

呼び出し側(`entrypoint.py`)は `needs_separate_raw_output()` で判断する:

- **2本**(th06/07/08/11の等倍録画): 録画された生データがそのまま「元解像度版」として
  通用するので、それを無加工でアップロードし、この変換の出力を「配信版」にする。
  再エンコードは1回だけで済む。
- **1本**(th20、および低速録画): 生データを配信版と別に出す意味が無い(解像度が同じで
  ウォーターマークの有無しか違わない)か、そもそも生データが半分の速度で通用しない。
  この変換の出力だけを配信する。
"""
import json
import subprocess
import time

TARGET_HEIGHT = 720
# on_progress コールバックを呼ぶ最小間隔(秒)。DynamoDBへの書き込み頻度を抑える。
PROGRESS_REPORT_INTERVAL_SEC = 10.0
# 低速録画を等倍へ戻すときに出力へ固定するフレームレート。
NATIVE_FRAME_RATE_HZ = 60.0


def probe_resolution(input_path):
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height", "-of", "json", input_path,
        ],
        capture_output=True, text=True, check=True,
    ).stdout
    stream = json.loads(out)["streams"][0]
    return stream["width"], stream["height"]


def probe_audio_sample_rate(input_path):
    """音声のサンプリングレート(Hz)。音声が無い・読めない場合は None。"""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=sample_rate", "-of", "default=nw=1:nk=1", input_path],
            capture_output=True, text=True, timeout=30,
        )
        return int(out.stdout.strip())
    except (subprocess.SubprocessError, ValueError, OSError):
        return None


def delivery_resolution(width, height):
    """配信版の解像度。720pに満たない録画だけアスペクト比を保って引き上げ、
    既に720p以上ならそのまま返す(モジュール docstring 参照)。"""
    if height >= TARGET_HEIGHT:
        return width, height
    return round(width * TARGET_HEIGHT / height / 2) * 2, TARGET_HEIGHT


def needs_separate_raw_output(width, height, time_scale=1.0):
    """録画された生データを「元解像度版」として別途配信する価値があるか。

    価値があるのは**解像度が実際に変わる等倍録画のときだけ**である。

    - 低速録画(`time_scale != 1.0`)の生データは半分の速度なので、そのままでは
      ユーザーに渡せない。別途出すには等倍化の再エンコードがもう1回要るが、
      得られるのは「配信版とウォーターマークの有無しか違わない動画」でしかない。
    - 解像度が変わらない録画(th20)も同様に、2本目はウォーターマークの有無しか
      違わない。S3保管料とCloudFront転送量が倍になるだけで、ウォーターマークが
      不要なユーザーはページAの詳細設定でオフにできる。
    """
    if time_scale != 1.0:
        return False
    return delivery_resolution(width, height) != (width, height)


def build_convert_cmd(input_path, output_path, *, width, height, time_scale=1.0,
                      watermark_path=None, watermark_width=428, audio_sample_rate=None):
    """変換1回ぶんの ffmpeg コマンドを組み立てる(実行はしない。テストしやすくするため)。"""
    target_width, target_height = delivery_resolution(width, height)

    video_filters = []
    if time_scale != 1.0:
        # 実時間がゲーム内時間の time_scale 倍かかっている録画を、その逆数で圧縮する。
        video_filters.append(f"setpts={1.0 / time_scale}*PTS")
    if (target_width, target_height) != (width, height):
        video_filters.append(f"scale={target_width}:{target_height}:flags=lanczos")
    video_chain = ",".join(video_filters) if video_filters else "null"

    graph = [f"[0:v]{video_chain}[base]"]
    if watermark_path:
        # ウォーターマーク幅は既定428pxでも、変換後の画面の半分より広くはしない
        # (狭いウィンドウで画面の大半を覆ってしまうのを防ぐ)。
        wm_w = min(watermark_width, target_width // 2)
        graph.append(f"[1:v]scale={wm_w}:-1[wm]")
        graph.append("[base][wm]overlay=x=W-w-8:y=H-h-8:eof_action=pass[v]")
    else:
        graph.append("[base]null[v]")

    audio_maps = []
    audio_codec = ["-c:a", "copy"]
    if time_scale != 1.0 and audio_sample_rate:
        # サンプルレートを上げて読む(asetrate)ことで早回しし、元のレートへ戻す
        # (aresample)。テープの早回しと同じ原理で、速度・ピッチとも同じ比率で戻る。
        asetrate = int(round(audio_sample_rate * time_scale))
        graph.append(f"[0:a]asetrate={asetrate},aresample={audio_sample_rate}[a]")
        audio_maps = ["-map", "[a]"]
        audio_codec = ["-c:a", "aac", "-b:a", "192k"]
    else:
        audio_maps = ["-map", "0:a"]

    cmd = ["ffmpeg", "-y", "-i", input_path]
    if watermark_path:
        # ウォーターマーク webm の VP9 アルファは libvpx 経由デコーダでないと
        # 不透明扱いになる(reports/18)。-c:v libvpx-vp9 を明示する。
        cmd += ["-c:v", "libvpx-vp9", "-i", watermark_path]
    cmd += ["-filter_complex", ";".join(graph), "-map", "[v]", *audio_maps]
    if time_scale != 1.0:
        # 等倍へ戻すときだけ出力フレームレートを固定する。録画自体は等倍と同じ
        # `-framerate 60` で撮っているため、低速録画の素材は各フレームが time_scale
        # 枚ずつ並んだ状態にある。PTSを圧縮したうえでここへ落とすと**重複が
        # ちょうど間引かれ**、等倍録画と同じ「60fps・全フレームユニーク」になる。
        cmd += ["-r", str(NATIVE_FRAME_RATE_HZ)]
    cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"]
    cmd += [*audio_codec, output_path]
    return cmd


def convert_for_delivery(input_path, output_path, *, time_scale=1.0, watermark_path=None,
                         watermark_width=428, on_progress=None, log=print, ffmpeg_log_path=None):
    """録画結果を配信用の1本へ変換する(モジュール docstring 参照)。

    on_progress が指定されていれば、実際に変換処理が完了した**出力側の**動画時間
    (秒、float)をおよそ PROGRESS_REPORT_INTERVAL_SEC 秒間隔で呼び出す。低速録画でも
    出力は等倍なので、この値はそのまま「コンテンツ秒数」として
    `replayInfo.estimatedDurationSeconds` と比較できる。

    ffmpeg_log_path を指定すると、`-progress` の生出力(frame=/fps=/bitrate=等、
    out_time_ms以外の全キー)をこのファイルへ書き出す。CloudWatch Logsへ全行流すと
    1ジョブで数千行に達し他のログを埋もれさせるため(Issue #58フォローアップ、実機の
    管理画面ログビューアで発覚)、`recording_common.py`のffmpeg_video.log/
    ffmpeg_audio.logと同じ方針でファイルへ退避し、呼び出し側(entrypoint.py)が
    変換完了後にS3(期限付き)へアップロードする。変換が失敗した場合のみ、診断のため
    末尾を`log()`(CloudWatch行き)にも残す。
    """
    width, height = probe_resolution(input_path)
    audio_sample_rate = probe_audio_sample_rate(input_path) if time_scale != 1.0 else None
    if time_scale != 1.0 and audio_sample_rate is None:
        # 音声トラック無しの録画は通常発生しないが、ここで丸ごと失敗させるより
        # 映像を救う方が損失が小さい(音声は元の速度のまま残るのではなく落ちる)。
        log("WARNING: 音声のサンプルレートを取得できませんでした。映像のみ等倍へ変換します")

    cmd = build_convert_cmd(
        input_path, output_path,
        width=width, height=height, time_scale=time_scale,
        watermark_path=watermark_path, watermark_width=watermark_width,
        audio_sample_rate=audio_sample_rate,
    )
    target_width, target_height = delivery_resolution(width, height)
    log(
        f"配信用に変換します: {width}x{height} -> {target_width}x{target_height} "
        f"(time_scale={time_scale} watermark={'あり' if watermark_path else 'なし'})"
    )

    if on_progress is None:
        subprocess.run(cmd, check=True)
        return

    # stderr を stdout にマージしてログへ流す(進捗追跡のため stdout をパイプで
    # 読む必要があるが、変換失敗時の診断情報(ffmpegのエラー出力)を捨てないため)。
    proc = subprocess.Popen(
        [*cmd[:-1], "-progress", "pipe:1", "-nostats", cmd[-1]],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    ffmpeg_log_file = open(ffmpeg_log_path, "w") if ffmpeg_log_path else None
    last_reported = 0.0
    try:
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            if ffmpeg_log_file:
                ffmpeg_log_file.write(line + "\n")
            if not line.startswith("out_time_ms="):
                continue
            try:
                # ffmpeg の `-progress` 出力は `out_time_ms` という名前だが、実体は
                # マイクロ秒単位(ffmpeg既知の命名の癖)。
                out_time_us = int(line.split("=", 1)[1])
            except ValueError:
                continue
            now = time.monotonic()
            if now - last_reported < PROGRESS_REPORT_INTERVAL_SEC:
                continue
            last_reported = now
            on_progress(out_time_us / 1_000_000)
    finally:
        if ffmpeg_log_file:
            ffmpeg_log_file.close()
    proc.wait()
    if proc.returncode != 0:
        if ffmpeg_log_path:
            try:
                with open(ffmpeg_log_path, "rb") as f:
                    tail = f.read()[-2000:]
                log(f"ffmpeg(配信用変換)ログ末尾: {tail.decode(errors='replace')}")
            except OSError:
                pass
        raise RuntimeError(f"ffmpeg による配信用変換に失敗しました (exit_code={proc.returncode})")
