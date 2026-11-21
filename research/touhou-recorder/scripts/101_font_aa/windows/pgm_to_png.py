"""Convert gdi_text_test PGMs to PNG and build Windows-vs-Linux side-by-side sheets.
Usage: python pgm_to_png.py <win_gdi_dir> <linux_gdi_dir>"""
import sys, os
from PIL import Image, ImageDraw
wd, ld = sys.argv[1:3]
for n in os.listdir(wd):
    if n.endswith('.pgm'):
        Image.open(os.path.join(wd, n)).save(os.path.join(wd, n[:-4] + '.png'))
for n in ('w400_q4', 'w700_q4'):
    w = Image.open(os.path.join(wd, n + '.pgm')); l = Image.open(os.path.join(ld, n + '.pgm'))
    # heights 12..24 (rows of 36px), left 330px, 2x nearest
    cw, ch = 330, 36 * 13
    c = Image.new('L', (cw * 2 * 2 + 20, ch * 2 + 24), 255)
    c.paste(w.crop((0, 0, cw, ch)).resize((cw * 2, ch * 2), Image.NEAREST), (0, 24))
    c.paste(l.crop((0, 0, cw, ch)).resize((cw * 2, ch * 2), Image.NEAREST), (cw * 2 + 20, 24))
    d = ImageDraw.Draw(c); d.text((4, 4), f'Windows {n} (h=12..24)', fill=0); d.text((cw * 2 + 24, 4), f'Wine {n} (h=12..24)', fill=0)
    c.save(os.path.join(wd, f'sidebyside_{n}.png'))
