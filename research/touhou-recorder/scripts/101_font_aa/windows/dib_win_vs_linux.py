"""Compare TextOutA post-draw DIB dumps (FONT_PROBE_DUMP_DIR) of Windows vs Linux pairwise by index.
Usage: python dib_win_vs_linux.py <win_dir> <linux_dir> <out_png_prefix>
Glyph mask = pixels whose top 4 bits (alpha) went 0xF -> 0x0. Reports per-dump counts of
win-only / linux-only / both, and writes PNG: rows = Windows, Linux, diff (red=Win only, blue=Linux only)."""
import struct, sys, os, numpy as np
from PIL import Image
def load(p):
    b=open(p,'rb').read(); w,h,bpp,stride=struct.unpack('<4I',b[:16])
    h=abs(int(np.int32(h))); return np.frombuffer(b[28:28+stride*h],'<u2').reshape(h,stride//2)[:, :w]
wd, ld, outp = sys.argv[1:4]
for i in range(1,13):
    n=f'textout_{i:02d}'
    try: wp,wq,lp,lq=[load(os.path.join(d,f'{n}_{t}.bin')) for d in (wd,ld) for t in ('pre','post')]
    except FileNotFoundError: continue
    wm=(wp>>12==15)&(wq>>12==0); lm=(lp>>12==15)&(lq>>12==0)
    if not wm.any() and not lm.any(): continue
    pre_same=bool((wp==lp).all())
    print(f'{n}: pre_identical={pre_same} win={int(wm.sum())} linux={int(lm.sum())} both={int((wm&lm).sum())} win_only={int((wm&~lm).sum())} linux_only={int((~wm&lm).sum())}')
    ys,xs=np.nonzero(wm|lm); y0,y1,x0,x1=ys.min(),ys.max()+1,xs.min(),min(xs.max()+1,xs.min()+400)
    def g(m): return np.where(m[y0:y1,x0:x1],0,255).astype(np.uint8)
    d=np.full((y1-y0,x1-x0,3),255,np.uint8); d[(wm&~lm)[y0:y1,x0:x1]]=[220,0,0]; d[(~wm&lm)[y0:y1,x0:x1]]=[0,0,220]; d[(wm&lm)[y0:y1,x0:x1]]=[160,160,160]
    rows=[Image.fromarray(g(wm)).convert('RGB'),Image.fromarray(g(lm)).convert('RGB'),Image.fromarray(d)]
    W,H=rows[0].size; c=Image.new('RGB',(W*3,(H*3+6)*3),(128,128,128))
    for k,r in enumerate(rows): c.paste(r.resize((W*3,H*3),Image.NEAREST),(0,k*(H*3+6)))
    c.save(f'{outp}_{n}.png')
