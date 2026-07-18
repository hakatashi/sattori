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
"""
import json
import subprocess

TARGET_HEIGHT = 720


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


def upscale_to_720p(input_path, output_path):
    """input_path の動画をアスペクト比を保ったまま高さ720pxへ変換する。"""
    width, height = probe_resolution(input_path)
    target_width = round(width * TARGET_HEIGHT / height / 2) * 2
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", input_path,
            "-vf", f"scale={target_width}:{TARGET_HEIGHT}:flags=lanczos",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-c:a", "copy",
            output_path,
        ],
        check=True,
    )
