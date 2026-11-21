"""Re-run native d3dx9 TRIANGLE offline over a D3DX_DUMP_DIR directory.

Usage: python run_offline.py <harness.exe> <d3dx9 dll> <in_dir> <out_dir> [filter] [fpu_preserve]
For each d3dx_NN_src.bin with a matching dst dump, the dst size comes from the dst dump and the
dst rect's y offset from the game's calls (1024x44->512x20 at y=1, 662x36->320x17 at y=92).
Writes d3dx_NN_src.bin (copied) and d3dx_NN_dst.bin (offline result) into out_dir, so
compare_xfer_dumps.py can pair them.
"""
import glob, os, shutil, struct, subprocess, sys

exe, dll, ind, outd = sys.argv[1:5]
filt = sys.argv[5] if len(sys.argv) > 5 else "4"
fpu = sys.argv[6] if len(sys.argv) > 6 else "0"
YOFF = {(512, 20): 1, (320, 17): 92}
os.makedirs(outd, exist_ok=True)
for s in sorted(glob.glob(os.path.join(ind, "d3dx_*_src.bin"))):
    d = s.replace("_src.bin", "_dst.bin")
    if not os.path.exists(d):
        continue
    dw, dh = struct.unpack("<2I", open(d, "rb").read(8))
    if (dw, dh) not in YOFF:
        continue
    name = os.path.basename(s)
    shutil.copy(s, os.path.join(outd, name))
    od = os.path.join(outd, name.replace("_src.bin", "_dst.bin"))
    r = subprocess.run([exe, dll, s, od, str(dw), str(dh), str(YOFF[(dw, dh)]), filt, fpu],
                       capture_output=True, text=True)
    print(name, dw, dh, "rc=", r.returncode, r.stderr.strip())
