#!/usr/bin/env python3
"""フラッシュ(xsetroot)+ビープ(paplay)を同時に発生させ、recorder/の等倍用・倍速用ffmpeg
コマンド(映像x11grab/音声pulse、-copyts)で録ったときのA/V同期を比較する(フェーズ87)。

Usage: python3 scripts/87_flash_beep_sync_test.py [libx264|nvenc]   (Xvfb :93 を内部で起動する)
"""
import subprocess, time, os, signal, numpy as np, sys
DISP=":93"; enc=sys.argv[1] if len(sys.argv)>1 else "libx264"
def pactl(*a): return subprocess.run(["pactl",*a],capture_output=True,text=True,env={**os.environ,"LC_ALL":"C"}).stdout.strip()
xv=subprocess.Popen(["Xvfb",DISP,"-screen","0","320x240x24"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); time.sleep(1)
env={**os.environ,"DISPLAY":DISP}
subprocess.run(["xsetroot","-solid","black"],env=env)
sr=44100; a=np.zeros(int(sr*0.3),np.int16); a[:int(sr*0.1)]=(np.sin(np.arange(int(sr*0.1))*2*np.pi*1000/sr)*20000).astype(np.int16)
import wave; w=wave.open("/tmp/p87_beep.wav","wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(a.tobytes()); w.close()
vcodec=["-c:v","h264_nvenc","-preset","p4","-rc","vbr","-cq","23"] if enc=="nvenc" else ["-c:v","libx264","-preset","veryfast"]
def run(mode):
    rate=44100 if mode=="native" else 88200
    sink=f"p87fb{rate}"; mod=pactl("load-module","module-null-sink",f"sink_name={sink}",f"rate={rate}","channels=2")
    fr="60" if mode=="native" else "120"
    vcmd=["ffmpeg","-y","-copyts","-f","x11grab","-draw_mouse","0","-video_size","320x240","-framerate",fr,"-i",DISP+"+0,0"]+(["-vsync","0"] if mode!="native" else [])+vcodec+["-pix_fmt","yuv420p",f"/tmp/p87_fb_{mode}.video.mp4"]
    acmd=["ffmpeg","-y","-copyts","-f","pulse"]+(["-sample_rate",str(rate)] if mode!="native" else [])+["-i",f"{sink}.monitor"]+(["-c:a","aac","-b:a","192k",f"/tmp/p87_fb_{mode}.audio.m4a"] if mode=="native" else ["-c:a","pcm_s16le",f"/tmp/p87_fb_{mode}.audio.mov"])
    vp=subprocess.Popen(vcmd,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    ap=subprocess.Popen(acmd,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    time.sleep(4)
    res=[]
    for k in range(4):
        subprocess.Popen(["paplay","--device",sink,"/tmp/p87_beep.wav"])
        subprocess.run(["xsetroot","-solid","white"],env=env); time.sleep(0.5)
        subprocess.run(["xsetroot","-solid","black"],env=env); time.sleep(1.0)
    time.sleep(1)
    for p in (vp,ap): p.send_signal(signal.SIGINT)
    for p in (vp,ap): p.wait()
    pactl("unload-module",mod)
    vf=f"/tmp/p87_fb_{mode}.video.mp4"; af=acmd[-1]
    st=lambda f: float(subprocess.run(["ffprobe","-v","error","-show_entries","stream=start_time","-of","csv=p=0",f],capture_output=True,text=True).stdout.strip())
    # 映像: 各フレームのpts付きで明るさ
    out=subprocess.run(["ffprobe","-v","error","-f","lavfi","-i",f"movie={vf},signalstats","-show_entries","frame=pts_time:frame_tags=lavfi.signalstats.YAVG","-of","csv=p=0"],capture_output=True,text=True).stdout
    fr_=[(float(l.split(",")[0]),float(l.split(",")[1])) for l in out.splitlines() if l.count(",")==1]
    vt=[t for (t,y),(t0,y0) in zip(fr_[1:],fr_) if y>128 and y0<=128]
    raw=subprocess.run(["ffmpeg","-v","error","-i",af,"-ac","1","-ar","48000","-f","s16le","-"],capture_output=True).stdout
    s=np.abs(np.frombuffer(raw,np.int16)); hits=np.where(s>5000)[0]
    ons=[hits[0]]+[h for p,h in zip(hits,hits[1:]) if h-p>48000*0.5]
    at=[st(af)+h/48000 for h in ons]
    vabs=vt  # movie filter pts already absolute with copyts? check
    print(mode, "video_start",st(vf),"audio_start",st(af))
    print(mode, "flash(pts)", [round(x,3) for x in vt]); print(mode,"beep(abs)",[round(x,3) for x in at])
    print(mode, "a-v(ms)", [round(1000*(a_-v_)) for a_,v_ in zip(at,vt)])
for m in ("native","speed2x","native","speed2x"): run(m)
xv.terminate()
