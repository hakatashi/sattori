#!/usr/bin/env python3
"""倍速録画の生データを、等倍へ戻す部分だけ`-r 60`に変えて再変換する(フェーズ92)。

本番の`convert.build_convert_cmd()`(sattori 30874c1以降)は`fps=60:start_time=0`フィルタで60fpsへ
揃えるが、x11grabのptsが揃っていない2倍速の素材では45fps相当へ落ちる(reports/92)。キャプチャ自体の
品質を比べるため、30874c1より前と同じ出力オプション`-r 60`で変換し直す。それ以外は本番のコマンドのまま。

Usage(コンテナ内、`-e GPU_WORKER=1`で本番と同じNVENC):
  python3 /verify/92_reconvert_r60.py /out/<label> <倍率>
"""
import json
import sys

sys.path.insert(0, "/app")

import subprocess  # noqa: E402

from convert import build_convert_cmd, probe_audio_sample_rate, probe_resolution  # noqa: E402
from recording import gpu_worker  # noqa: E402

FPS_FILTER = ",fps=60:start_time=0"


def main():
    out, mult = sys.argv[1], float(sys.argv[2])
    src = f"{out}/video.mp4"
    dst = f"{out}/video_delivery_r60.mp4"
    with open(f"{out}/cut_result.json") as f:
        cut = json.load(f)
    width, height = probe_resolution(src)
    cmd = build_convert_cmd(
        src, dst, width=width, height=height, time_scale=1.0 / mult,
        watermark_path="/app/assets/watermark/watermark-60fps.webm",
        audio_sample_rate=probe_audio_sample_rate(src), gpu_encode=gpu_worker(),
        cut_start=cut.get("startSec"), cut_end=cut.get("endSec"),
    )
    i = cmd.index("-filter_complex") + 1
    if FPS_FILTER not in cmd[i]:
        raise SystemExit(f"fpsフィルタが見つかりません: {cmd[i]}")
    cmd[i] = cmd[i].replace(FPS_FILTER, "")
    cmd[-1:-1] = ["-r", "60"]
    subprocess.run(cmd, check=True, stdin=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
