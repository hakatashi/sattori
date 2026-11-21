#!/usr/bin/env python3
"""sattori本番 worker/convert.py と同じ配信版変換(リサイズ+ウォーターマーク+2出力)の所要時間を計測する(フェーズ109)。

Usage:
  python3 scripts/109_bench_convert.py <input.mp4> [--gpu-encode] [--watermark assets/watermark/watermark-60fps.webm]
"""
import argparse
import json
import os
import subprocess
import tempfile
import time


def probe(path):
    v = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "json", path],
        capture_output=True, text=True, check=True).stdout
    st = json.loads(v)["streams"][0]
    d = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True, check=True).stdout
    return int(st["width"]), int(st["height"]), float(d.strip())


def delivery_resolution(w, h):
    for th in (720, 1080):
        if h == th:
            return w, h
        if h < th:
            return round(w * th / h / 2) * 2, th
    return w, h


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--gpu-encode", action="store_true")
    ap.add_argument("--watermark", default="assets/watermark/watermark-60fps.webm")
    args = ap.parse_args()

    w, h, dur = probe(args.input)
    tw, th = delivery_resolution(w, h)
    cut_start = 10.0
    cut_end = max(cut_start + 10.0, dur - 16.0)
    play_dur = cut_end - cut_start

    vf = [f"trim=start={cut_start:.6f}:end={cut_end:.6f}",
          f"setpts=(PTS-{cut_start:.6f}/TB)",
          "fps=60:start_time=0",
          "split=2[vsrc][vraw];[vsrc]null"]
    if (tw, th) != (w, h):
        vf.append(f"scale={tw}:{th}:flags=lanczos")
    graph = [f"[0:v]{','.join(vf)}[base]"]
    if os.path.exists(args.watermark):
        wm_w = min(428, tw // 2)
        graph.append(f"[1:v]scale={wm_w}:-1[wm]")
        graph.append("[base][wm]overlay=x=W-w-8:y=H-h-8:eof_action=pass[v]")
    else:
        graph.append("[base]null[v]")

    af = [f"aresample=first_pts=0", f"atrim=start={cut_start:.6f}:end={cut_end:.6f}",
          f"asetpts=PTS-{cut_start:.6f}/TB", "asplit=2[a][araw]"]
    graph.append(f"[0:a]{','.join(af)}")

    enc = (["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "25", "-b:v", "0", "-pix_fmt", "yuv420p"]
           if args.gpu_encode
           else ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"])

    with tempfile.TemporaryDirectory() as td:
        out_deliv = os.path.join(td, "delivery.mp4")
        out_raw = os.path.join(td, "raw.mp4")
        cmd = ["ffmpeg", "-y", "-nostdin", "-i", args.input]
        if os.path.exists(args.watermark):
            cmd += ["-c:v", "libvpx-vp9", "-i", args.watermark]
        cmd += ["-filter_complex", ";".join(graph),
                "-map", "[v]", *enc, "-map", "[a]", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out_deliv,
                "-map", "[vraw]", *enc, "-map", "[araw]", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out_raw]
        t0 = time.time()
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        elapsed = time.time() - t0
    print(f"input={args.input} {w}x{h}->{tw}x{th} gpu={args.gpu_encode} play_dur={play_dur:.1f}s "
          f"convert_elapsed={elapsed:.2f}s ratio={elapsed / play_dur:.4f}")


if __name__ == "__main__":
    main()
