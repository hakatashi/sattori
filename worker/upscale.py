#!/usr/bin/env python3
"""録画済み動画を 720p へアップスケールする(Sattori ワーカー)。

th07(妖々夢)のような 640x480 相当の低解像度録画は、そのまま YouTube へ
アップロードすると 60fps として認識されないことが判明した。ユーザーの利便性を
考え、録画完了後に別ファイルとして 720p 版を追加で生成する
(touhou-recorder reports/21)。

録画と同時にアップスケールする方式は、4vCPU 構成(実用下限)で重複フレーム率を
2倍以上悪化させることが検証で分かっているため採用しない。録画には一切影響を
与えない「録画完了後の別ステップ」として実装する。

出力解像度は入力のアスペクト比を保って高さ720pxに合わせる(th07の640x480なら
960x720)。「720p」という呼称に引きずられて1280x720(16:9)へ固定すると、
4:3コンテンツが横方向だけ引き伸ばされて歪むため(reports/21)。

ウォーターマークもこのステップで合成する(録画時(x11grab)には合成しない)。
x11grabの生ptsはwallclockベース(実epoch秒)で、A/V同期補正用の`-copyts`により
無加工のままoverlay filterのfiltergraphに渡ってしまうため、ほぼ0起点の
ウォーターマーク動画(ファイル入力)とフレーム同期が全く噛み合わずoverlayが
不発になる不具合があった(本番のth08録画で発覚)。ここではinput_pathが
`-copyts`を使わない通常の完成済みファイルであるため、overlay filterが正しく
機能する。また、どのみち720p変換のために発生する再エンコード1回に相乗りできる
ため、ウォーターマーク合成による追加の再エンコードコストが生じない。この
トレードオフとして、720p変換前の元解像度版(副次ダウンロードリンク)には
ウォーターマークが合成されない。
"""
import json
import subprocess
import time

TARGET_HEIGHT = 720
# on_progress コールバックを呼ぶ最小間隔(秒)。DynamoDBへの書き込み頻度を抑える。
PROGRESS_REPORT_INTERVAL_SEC = 10.0


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


def probe_duration(input_path):
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "json", input_path,
        ],
        capture_output=True, text=True, check=True,
    ).stdout
    duration = json.loads(out)["format"].get("duration")
    return float(duration) if duration is not None else None


def upscale_to_720p(input_path, output_path, watermark_path=None, watermark_width=285,
                     on_progress=None, log=print):
    """input_path の動画をアスペクト比を保ったまま高さ720pxへ変換する。
    watermark_path を指定すると、変換と同時にウォーターマークも合成する(モジュール
    docstring参照)。

    on_progress が指定されていれば、変換の進捗率(0-100のfloat、完了直前まで)を
    およそ PROGRESS_REPORT_INTERVAL_SEC 秒間隔で呼び出す。
    """
    width, height = probe_resolution(input_path)
    target_width = round(width * TARGET_HEIGHT / height / 2) * 2
    if watermark_path:
        # ウォーターマーク webm の VP9 アルファは libvpx 経由デコーダでないと
        # 不透明扱いになる(reports/18)。-c:v libvpx-vp9 を明示する。
        # ウォーターマーク幅は既定285pxでも、変換後の画面の半分より広くはしない
        # (狭いウィンドウで画面の大半を覆ってしまうのを防ぐ)。
        wm_w = min(watermark_width, target_width // 2)
        cmd = [
            "ffmpeg", "-y", "-i", input_path, "-c:v", "libvpx-vp9", "-i", watermark_path,
            "-filter_complex",
            f"[0:v]scale={target_width}:{TARGET_HEIGHT}:flags=lanczos[base];"
            f"[1:v]scale={wm_w}:-1[wm];[base][wm]overlay=x=W-w-8:y=H-h-8:eof_action=pass[v]",
            "-map", "[v]", "-map", "0:a",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-c:a", "copy",
            output_path,
        ]
    else:
        cmd = [
            "ffmpeg", "-y", "-i", input_path,
            "-vf", f"scale={target_width}:{TARGET_HEIGHT}:flags=lanczos",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-c:a", "copy",
            output_path,
        ]

    total_duration = probe_duration(input_path) if on_progress else None
    if on_progress is None or not total_duration:
        subprocess.run(cmd, check=True)
        return

    # stderr を stdout にマージしてログへ流す(進捗追跡のため stdout をパイプで
    # 読む必要があるが、変換失敗時の診断情報(ffmpegのエラー出力)を捨てないため)。
    proc = subprocess.Popen(
        [*cmd[:-1], "-progress", "pipe:1", "-nostats", cmd[-1]],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    last_reported = 0.0
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        if not line.startswith("out_time_ms="):
            log(f"[ffmpeg] {line}")
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
        percent = min(99.0, out_time_us / 1_000_000 / total_duration * 100)
        on_progress(percent)
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg によるアップスケール変換に失敗しました (exit_code={proc.returncode})")
