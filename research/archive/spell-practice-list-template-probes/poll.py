"""終了検知のサブ出力(160x120 グレー、8fps の生ストリーム)と完成済み mp4 を、同じ形の配列として読む。"""
import subprocess

import numpy as np

W, H = 160, 120


def load(path):
    """`output/repro.pollstream.raw`(recording/framesync.py の paths["poll"])を (n, 120, 160) で読む。"""
    b = np.fromfile(path, dtype=np.uint8)
    n = len(b) // (W * H)
    return b[:n * W * H].reshape(n, H, W).astype(np.float32)


def decode(video, fps=8):
    """完成済みの mp4 をサブ出力と同じ 8fps・160x120 グレーへ落とす(誤検知の走査用)。"""
    p = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", video, "-vf", f"fps={fps},scale={W}:{H}",
         "-pix_fmt", "gray", "-f", "rawvideo", "-"], capture_output=True)
    b = np.frombuffer(p.stdout, np.uint8)
    n = len(b) // (W * H)
    return b[:n * W * H].reshape(n, H, W).astype(np.float32)
