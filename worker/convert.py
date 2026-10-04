#!/usr/bin/env python3
"""録画結果を「ユーザーへ配信する1本」へ変換する後処理(Sattori ワーカー)。

**録画後の再エンコードは、どのタイトル・どの録画速度でもこの1パスだけ**。次の4つを
1つの ffmpeg 呼び出し(1回の filter_complex)にまとめてある:

  1. リプレイ再生区間外のカット(Issue #266): メニューの自動操作と、終了検知を確定させる
     までの静止画面を落とす。範囲は録画側が決めて渡す(`recording/cut.py`)。
  2. 等倍への戻し(倍速録画 Issue #288): 映像のPTSを伸縮し、音声の
     サンプルレートを逆比率で読み替える(テープの早回し・遅回しの逆)。旧低速録画(scale>1)の
     チェックポイントからの再開用に、scale>1の経路も残してある。速度・ピッチとも
     同じ比率で戻るので劣化なく復元できる(touhou-recorder reports/47・85)。
  3. 解像度合わせ: **720p・1080pに満たない録画だけ、そのすぐ上へ引き上げる** —— 後述。
  4. ウォーターマークの合成: x11grab録画時ではなくここで行う。録画時は`-copyts`で
     生ptsがwallclock(実epoch秒)のまま filtergraph に渡るため、ほぼ0起点の
     ウォーターマーク動画とフレーム同期が噛み合わず overlay が不発になる
     (本番のth08録画で発覚)。完成済みファイル入力同士のここでは正しく機能する。

あわせて、**映像・音声とも出力の0秒から始める**。音声の開始が映像より遅い録画(mux時の
A/V同期補正で音声を後ろへずらしたもの)をそのまま出すと、MP4上では先頭の「空編集」(elst)に
なり、ブラウザによっては先頭からの再生で無視されて音ズレする(Issue #301)。先頭を実際の
無音で埋める(`aresample=first_pts=0`)。

## 解像度の引き上げ先(720p・1080p)

引き上げる理由は、YouTube が動画を決まった解像度の段(720p・1080p)で配信することにある。
th07(640x480)のような低解像度録画は、そのままでは60fpsとして認識されない(reports/21)。
th20(1280x960)のように段の間にある録画は**下の段(720p)へ縮小して配信される**(Issue #284)。
そこで、高さが720px未満なら720pへ、720px超1080px未満なら1080pへ引き上げる。**ちょうど
720p・1080pの録画(th06ncの1280x720・1920x1080)はそのまま通す**。

出力解像度をアスペクト比を保って決めるのは共通で、「720pという呼称に引きずられて
1280x720(16:9)へ固定すると4:3コンテンツが横方向だけ引き伸ばされて歪む」(reports/21)
という制約も変わらない。

## 出力が1本になる場合と2本になる場合

呼び出し側(`entrypoint.py`)は `needs_separate_raw_output()` で判断する:

- **2本**(解像度が変わる等倍録画。640x480のタイトルとth15/th20): 配信版に加えて、元の解像度・
  ウォーターマーク無しの版も出す。カットした結果でなければならないので、録画の生データを
  そのまま出すのではなく、**同じ ffmpeg 呼び出しの2つ目の出力**として作る(デコードと
  フィルタは1回で済む)。
- **1本**(th06nc、および倍速録画): 元の解像度版を別に出す意味が無い(解像度が同じで
  ウォーターマークの有無しか違わない)か、そもそも生データが等倍の速度でないため
  通用しない。配信版だけを出す。

## GPUワーカーではNVENCでエンコードする

GPUワーカー(`GPU_WORKER=1`、`recording.timing.gpu_worker()`)ではこの変換もNVENCへ
オフロードする(touhou-recorder reports/84で720p変換のCPU時間が58%減)。NVENCは同じ
品質値でもlibx264よりビットレートが2.7〜3倍高くなる(reports/84)ため、品質値を
libx264 crf18の出力サイズに揃うよう調整してある(`NVENC_DELIVERY_CQ`)。配信版の
サイズはCloudFrontの無料枠(1TB/月)にそのまま効くので、ここを変える場合は
必ず同じ録画でlibx264版とサイズを比較すること。
"""
import json
import subprocess
import time

# 解像度を引き上げる先の高さ(低い順)。モジュール docstring 参照。
TARGET_HEIGHTS = (720, 1080)
# on_progress コールバックを呼ぶ最小間隔(秒)。DynamoDBへの書き込み頻度を抑える。
PROGRESS_REPORT_INTERVAL_SEC = 10.0
# 倍速録画を等倍へ戻すときに出力へ固定するフレームレート。
NATIVE_FRAME_RATE_HZ = 60.0

# NVENCで配信版を作るときの品質値(`-rc vbr -cq`、`-b:v 0`で品質固定=libx264のCRF相当)。
# 配信版のビットレートはタイトル(画面の内容)で4〜13Mbpsと大きく違う(2026-09の本番実績、
# libx264 crf18)ため、固定ビットレートではなく内容に適応する品質固定にする。
# 本番E2Eで8タイトルの生データをCQ23〜29で変換して比べ、libx264 crf18と合計サイズが
# 揃い(+2%)、SSIMもほぼ同等になる25に確定した(タイトル別のサイズ比は0.87〜1.28。
# `docs/reports/2026-10-02-speedup-production-e2e.md`、Issue #288)。
NVENC_DELIVERY_CQ = 25
# poster画像を切り出す位置(動画全体に対する割合)。0.9=末尾から数えて全体の90%地点。
# 終盤の弾幕が盛り上がったシーンを狙う(Issue #171、リプレイ再生終了後の何も無い
# 背景や選択画面が写り込む末尾ぎりぎりは避ける)。
POSTER_POSITION_RATIO = 0.9


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


def probe_duration(input_path):
    """動画の総尺(秒)。取得できない場合は None。"""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", input_path],
            capture_output=True, text=True, timeout=30,
        )
        return float(out.stdout.strip())
    except (subprocess.SubprocessError, ValueError, OSError):
        return None


def extract_poster_frame(input_path, output_path, *, position_ratio=POSTER_POSITION_RATIO, log=print):
    """配信版動画から `position_ratio` 地点の1フレームをJPEGとして切り出す(Issue #171)。

    それまでプレビュープレイヤーの`poster`には録画中最後のスクリーンショットを
    使い回していたが、それはリプレイ再生終了後の何も無い背景やリプレイ選択画面の
    ことが多く味気なかった。配信版動画自体から終盤(既定90%地点)のフレームを
    切り出すことで、弾幕が盛り上がっているシーンを狙う。

    `-ss`を`-i`より前に置く高速シークを使う(キーフレーム単位のため厳密に
    `position_ratio`ちょうどにはならないが、poster用途ではフレーム精度は不要で
    変換コストを増やさないことを優先する)。

    総尺の取得やffmpeg実行に失敗した場合は例外を投げず False を返す。呼び出し側は
    poster無しで続行してよい(=フロントは従来どおり進捗中スクリーンショットへ
    フォールバックするだけで、動画の再生自体には支障が無い)。
    """
    duration = probe_duration(input_path)
    if duration is None:
        log("WARNING: 動画の長さを取得できずposter画像の生成をスキップしました")
        return False
    seek_seconds = max(0.0, duration * position_ratio)
    cmd = [
        "ffmpeg", "-y", "-nostdin", "-ss", str(seek_seconds), "-i", input_path,
        "-frames:v", "1", "-q:v", "2", output_path,
    ]
    try:
        subprocess.run(cmd, check=True, stdin=subprocess.DEVNULL, capture_output=True)
        return True
    except subprocess.CalledProcessError as err:
        log(f"WARNING: poster画像の生成に失敗しました: {err}")
        return False


def delivery_resolution(width, height):
    """配信版の解像度。720p・1080pに満たない録画はアスペクト比を保ってそのすぐ上の段へ
    引き上げ、どちらかちょうど、または1080pを超えるならそのまま返す(モジュール docstring 参照)。"""
    for target_height in TARGET_HEIGHTS:
        if height == target_height:
            return width, height
        if height < target_height:
            return round(width * target_height / height / 2) * 2, target_height
    return width, height


def needs_separate_raw_output(width, height, time_scale=1.0):
    """録画された生データを「元解像度版」として別途配信する価値があるか。

    価値があるのは**解像度が実際に変わる等倍録画のときだけ**である。

    - 倍速録画(`time_scale != 1.0`)は1本のまま。生データが等倍の速度でないため元から
      「録画そのままの版」を出せず、2本目は等倍化した上でのエンコードがもう1本要る
      (倍速録画の導入時からの判断。カット導入で等倍録画も2本目を作り直すようになったが、
      倍速録画まで2本にするかは別途判断する)。
    - 解像度が変わらない録画(th06nc)も同様に、2本目はウォーターマークの有無しか
      違わない。S3保管料とCloudFront転送量が倍になるだけで、ウォーターマークが
      不要なユーザーはページAの詳細設定でオフにできる。
    """
    if time_scale != 1.0:
        return False
    return delivery_resolution(width, height) != (width, height)


def _delivery_video_encoder_args(gpu_encode):
    if gpu_encode:
        return ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr",
                "-cq", str(NVENC_DELIVERY_CQ), "-b:v", "0", "-pix_fmt", "yuv420p"]
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"]


def _trim_args(cut_start, cut_end):
    args = []
    if cut_start:
        args.append(f"start={cut_start:.6f}")
    if cut_end is not None:
        args.append(f"end={cut_end:.6f}")
    return ":".join(args)


def build_convert_cmd(input_path, output_path, *, width, height, time_scale=1.0,
                      watermark_path=None, watermark_width=428, audio_sample_rate=None,
                      gpu_encode=False, cut_start=None, cut_end=None, raw_output_path=None):
    """変換1回ぶんの ffmpeg コマンドを組み立てる(実行はしない。テストしやすくするため)。

    `cut_start`/`cut_end`は残す範囲(入力の時間軸の秒、Noneならその側はカットしない、
    `recording/cut.py`)。`raw_output_path`を指定すると、元の解像度・ウォーターマーク無しの
    版を2つ目の出力として同時に書き出す(モジュール docstring)。"""
    target_width, target_height = delivery_resolution(width, height)
    trim = _trim_args(cut_start, cut_end)
    origin = cut_start or 0.0

    video_filters = []
    if trim:
        video_filters.append(f"trim={trim}")
    # 残す範囲の先頭を0秒にし、実時間がゲーム内時間の time_scale 倍かかっている録画を
    # その逆数で伸縮する(scale>1は圧縮、倍速録画は引き伸ばし)。
    pts = f"(PTS-{origin:.6f}/TB)" if origin else "PTS"
    if time_scale != 1.0:
        video_filters.append(f"setpts={1.0 / time_scale}*{pts}")
    elif origin:
        video_filters.append(f"setpts={pts}")
    # 出力のフレームレートを固定する。倍速録画は60×倍率fpsで`-vsync 0`(可変フレーム
    # レート)のまま撮っているので、PTSを引き伸ばしたうえでここで60fps固定に揃える
    # (touhou-recorder reports/85・89)。旧低速録画(scale>1)は等倍と同じ`-framerate 60`で
    # 撮っているため、素材は各フレームが time_scale 枚ずつ並んだ状態にある。PTSを圧縮した
    # うえでここへ落とすと**重複がちょうど間引かれ**、等倍録画と同じ「60fps・全フレーム
    # ユニーク」になる。等倍録画は元から60fpsなので実質何もしない。`start_time=0`で、
    # 映像の先頭が0秒より後ろにある(mux時に映像を後ろへずらした)録画も0秒から始める
    # (最初のフレームを複製して埋める、Issue #301)。
    video_filters.append(f"fps={NATIVE_FRAME_RATE_HZ:g}:start_time=0")
    if raw_output_path:
        video_filters.append("split=2[vsrc][vraw];[vsrc]null")
    if (target_width, target_height) != (width, height):
        video_filters.append(f"scale={target_width}:{target_height}:flags=lanczos")

    graph = [f"[0:v]{','.join(video_filters)}[base]"]
    if watermark_path:
        # ウォーターマーク幅は既定428pxでも、変換後の画面の半分より広くはしない
        # (狭いウィンドウで画面の大半を覆ってしまうのを防ぐ)。
        wm_w = min(watermark_width, target_width // 2)
        graph.append(f"[1:v]scale={wm_w}:-1[wm]")
        graph.append("[base][wm]overlay=x=W-w-8:y=H-h-8:eof_action=pass[v]")
    else:
        graph.append("[base]null[v]")

    # 音声の先頭が0秒より後ろにある(mux時のA/V同期補正で後ろへずらした)なら、そこまでを
    # 実際の無音で埋める。埋めないとMP4上では先頭の空編集(elst)になり、ブラウザによっては
    # 先頭からの再生で無視されて音ズレする(Issue #301)。
    #
    # **カットより先に埋めること**。録音した音声のパケットのpts(pulseの読み取り時刻)は
    # 先頭からのサンプル数の積算と少しずつずれており、ptsで切る`atrim`を先に掛けると
    # 切り口がずれる(th08の実録画で+26ms)。先に埋めると以降のptsはサンプル数の積算に
    # なり、mux時の同期マーカー検証(`recording/sync_marker.py`)や再生時と同じ時間軸で切れる。
    # 等倍化より前に置くのは、無音の長さも一緒に伸縮させるため。
    audio_filters = ["aresample=first_pts=0"]
    if trim:
        audio_filters.append(f"atrim={trim}")
    if origin:
        audio_filters.append(f"asetpts=PTS-{origin:.6f}/TB")
    has_audio = True
    if time_scale != 1.0:
        if audio_sample_rate:
            # サンプルレートを読み替える(asetrate)ことで早回し・遅回しし、リサンプルする
            # (aresample)。テープの早回しと同じ原理で、速度・ピッチとも同じ比率で戻る。
            # 出力レートは等倍換算の低い方に揃える: scale>1は録音レート(44100Hz)のまま、
            # 倍速録画は録音レート(2倍速なら88200Hz)を倍率で割った値(44100Hz)になる。
            # 倍速録画の録音レートのまま出すと、中身は44100Hz相当なのにファイルだけ大きくなる。
            asetrate = int(round(audio_sample_rate * time_scale))
            output_rate = min(audio_sample_rate, asetrate)
            audio_filters.append(f"asetrate={asetrate},aresample={output_rate}")
        else:
            # 等倍へ戻すのにサンプルレートが分からない場合は**音声を落とす**。
            # そのまま残すと、映像だけPTSが伸縮した横で元の長さの音声が丸ごと残り、
            # 冒頭からずれた・尺も違う動画になる(呼び出し側が出す「映像のみ等倍へ変換します」
            # の警告とも食い違う)。無音の方が被害が小さい。
            has_audio = False
    if has_audio:
        if raw_output_path:
            audio_filters.append("asplit=2[a][araw]")
            graph.append(f"[0:a]{','.join(audio_filters)}")
        else:
            graph.append(f"[0:a]{','.join(audio_filters)}[a]")

    def output_args(video_label, audio_label, path):
        args = ["-map", video_label]
        args += _delivery_video_encoder_args(gpu_encode)
        if has_audio:
            # カット・無音埋めのため音声も必ず再エンコードする(等倍録画も`-c:a copy`できない)。
            args += ["-map", audio_label, "-c:a", "aac", "-b:a", "192k"]
        else:
            args += ["-an"]
        # moov atomを先頭に移す(faststart)。無指定だと末尾に置かれ、ブラウザでの
        # ストリーミング再生時に末尾へのRangeリクエストが追加で発生してしまう(Issue #90)。
        args += ["-movflags", "+faststart", path]
        return args

    cmd = ["ffmpeg", "-y", "-nostdin", "-i", input_path]
    if watermark_path:
        # ウォーターマーク webm の VP9 アルファは libvpx 経由デコーダでないと
        # 不透明扱いになる(reports/18)。-c:v libvpx-vp9 を明示する。
        cmd += ["-c:v", "libvpx-vp9", "-i", watermark_path]
    cmd += ["-filter_complex", ";".join(graph)]
    cmd += output_args("[v]", "[a]", output_path)
    if raw_output_path:
        cmd += output_args("[vraw]", "[araw]", raw_output_path)
    return cmd


def convert_for_delivery(input_path, output_path, *, time_scale=1.0, watermark_path=None,
                         watermark_width=428, on_progress=None, log=print, ffmpeg_log_path=None,
                         gpu_encode=False, cut_start=None, cut_end=None, raw_output_path=None):
    """録画結果を配信用の1本(`raw_output_path`指定時は元の解像度版との2本)へ変換する
    (モジュール docstring 参照)。

    on_progress が指定されていれば、実際に変換処理が完了した**出力側の**動画時間
    (秒、float)をおよそ PROGRESS_REPORT_INTERVAL_SEC 秒間隔で呼び出す。倍速録画でも
    出力は等倍なので、この値はそのまま「コンテンツ秒数」として
    `replayInfo.estimatedDurationSeconds` と比較できる。

    ffmpeg_log_path を指定すると、`-progress` の生出力(frame=/fps=/bitrate=等、
    out_time_ms以外の全キー)をこのファイルへ書き出す。CloudWatch Logsへ全行流すと
    1ジョブで数千行に達し他のログを埋もれさせるため(Issue #58フォローアップ、実機の
    管理画面ログビューアで発覚)、`recording/pipeline.py`のffmpeg_video.log/
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
        audio_sample_rate=audio_sample_rate, gpu_encode=gpu_encode,
        cut_start=cut_start, cut_end=cut_end, raw_output_path=raw_output_path,
    )
    target_width, target_height = delivery_resolution(width, height)
    log(
        f"配信用に変換します: {width}x{height} -> {target_width}x{target_height} "
        f"(time_scale={time_scale} watermark={'あり' if watermark_path else 'なし'} "
        f"encoder={'NVENC' if gpu_encode else 'libx264'} cut={cut_start}〜{cut_end} "
        f"元の解像度版={'あり' if raw_output_path else 'なし'})"
    )

    if on_progress is None:
        subprocess.run(cmd, check=True, stdin=subprocess.DEVNULL)
        return

    # stderr を stdout にマージしてログへ流す(進捗追跡のため stdout をパイプで
    # 読む必要があるが、変換失敗時の診断情報(ffmpegのエラー出力)を捨てないため)。
    # `-progress`はグローバルオプションなので、出力が2つある場合も先頭に置く。
    proc = subprocess.Popen(
        [cmd[0], "-progress", "pipe:1", "-nostats", *cmd[1:]],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
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
