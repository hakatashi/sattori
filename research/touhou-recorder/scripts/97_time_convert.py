#!/usr/bin/env python3
"""フェーズ97: 配信版変換(sattori worker/convert.pyのbuild_convert_cmd、カット・ウォーターマーク無し)だけの実時間を測る。

Usage: python3 scripts/97_time_convert.py <raw.mp4>:<time_scale> [...]   (リポジトリルートの worker/ を使う)"""
import sys, time, subprocess, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "worker"))
import convert
for spec in sys.argv[1:]:
    path, scale = spec.split(":"); scale = float(scale)
    w, h = convert.probe_resolution(path)
    sr = convert.probe_audio_sample_rate(path) if scale != 1.0 else None
    cmd = convert.build_convert_cmd(path, "/tmp/tc.mp4", width=w, height=h, time_scale=scale, audio_sample_rate=sr)
    t = time.time(); subprocess.run(cmd, check=True, capture_output=True); dt = time.time() - t
    print(f"{os.path.basename(path)} {w}x{h} scale={scale} raw={convert.probe_duration(path):.1f}s convert={dt:.1f}s", flush=True)
    os.remove("/tmp/tc.mp4")
