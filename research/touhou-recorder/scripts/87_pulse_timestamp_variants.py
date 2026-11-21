#!/usr/bin/env python3
"""pulse入力の開始タイムスタンプの偏りを、シンク(既定auto_null/新規null-sink)と録音形式(AAC m4a /
PCM mov / -sample_rate指定)の組み合わせごとに測る(フェーズ87 §6)。
scripts/87_measure_dsound_latency.py の measure() と同じ手順を、条件を変えて繰り返す。

Usage: DISPLAY=:91 WINEPREFIX=$PWD/prefixes/th15-wined3d-gl python3 scripts/87_pulse_timestamp_variants.py
"""
import sys, os, time, subprocess, importlib.util, numpy as np
spec=importlib.util.spec_from_file_location('m',os.path.join(os.path.dirname(os.path.abspath(__file__)), '87_measure_dsound_latency.py')); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
import signal, re
def run(label, sink, rec_args, pulse_sink, preload_wait=0, mod=None):
    if preload_wait: time.sleep(preload_wait)
    out_path=rec_args[-1]
    rec=subprocess.Popen(["ffmpeg","-y","-copyts","-f","pulse"]+rec_args,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    time.sleep(1.0)
    env=dict(os.environ,WINEDEBUG="-all")
    if pulse_sink: env["PULSE_SINK"]=pulse_sink
    out=subprocess.run(["wine",m.PROBE,"--freq","44100"],capture_output=True,text=True,env=env).stdout
    time.sleep(0.5); rec.send_signal(signal.SIGINT); rec.wait()
    t0,interval=[float(x) for x in re.search(r"PLAY_EPOCH ([0-9.]+) FREQ \d+ CLICK_INTERVAL ([0-9.]+)",out).groups()]
    start=float(subprocess.run(["ffprobe","-v","error","-show_entries","stream=start_time","-of","csv=p=0",out_path],capture_output=True,text=True).stdout.strip())
    a=np.abs(np.frombuffer(subprocess.run(["ffmpeg","-v","error","-i",out_path,"-ac","1","-f","s16le","-"],capture_output=True).stdout,np.int16).astype(np.int32))
    rate=int(subprocess.run(["ffprobe","-v","error","-show_entries","stream=sample_rate","-of","csv=p=0",out_path],capture_output=True,text=True).stdout.strip())
    hits=np.where(a>8000)[0]; ons=[hits[0]]+[h for p,h in zip(hits,hits[1:]) if h-p>rate*interval/2]
    lat=[start+h/rate-(t0+(k+1)*interval) for k,h in enumerate(ons)]
    print(f"{label:45s} latency={np.mean(lat)*1000:7.1f}ms", flush=True)
for r in range(2):
    run("auto_null / AAC m4a (native path)","auto_null",["-i","auto_null.monitor","-c:a","aac","-b:a","192k","/tmp/v1.m4a"],None)
    run("auto_null / PCM mov","auto_null",["-i","auto_null.monitor","-c:a","pcm_s16le","/tmp/v2.mov"],None)
    run("auto_null / PCM mov -sample_rate 44100","auto_null",["-sample_rate","44100","-i","auto_null.monitor","-c:a","pcm_s16le","/tmp/v3.mov"],None)
    mod=m.pactl("load-module","module-null-sink","sink_name=p87v","rate=44100","channels=2")
    run("fresh sink / AAC m4a","p87v",["-i","p87v.monitor","-c:a","aac","-b:a","192k","/tmp/v4.m4a"],"p87v")
    run("sink aged 10s / PCM mov -sample_rate","p87v",["-sample_rate","44100","-i","p87v.monitor","-c:a","pcm_s16le","/tmp/v5.mov"],"p87v",preload_wait=10)
    m.pactl("unload-module",mod)
