#!/usr/bin/env python3
"""Wineゲームプロセスのメモリを /proc/PID/mem から高頻度で読み、変化を記録する。
usage: memwatch.py --exe th11.exe --out log --region label:addr[:deref]:size ... [--trigger addr:width:value --scan v1,v2]
"""
import argparse, os, re, struct, sys, time, subprocess

ap = argparse.ArgumentParser()
ap.add_argument("--exe", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--region", action="append", default=[])  # label:addr:deref(0/1):size
ap.add_argument("--trigger", default=None)  # label:index32:value  -> when int32 at index equals value, scan
ap.add_argument("--scan", default="")       # comma-separated int32 values to search
ap.add_argument("--scan-width", type=int, default=4)
args = ap.parse_args()

def find_pid():
    for p in os.listdir("/proc"):
        if not p.isdigit(): continue
        try:
            cmd = open(f"/proc/{p}/cmdline", "rb").read().replace(b"\0", b" ").decode(errors="replace").lower()
        except OSError:
            continue
        if "memwatch" in cmd or "python" in cmd or "record_" in cmd: continue
        first = cmd.split(" ")[0]
        if first.endswith("\\" + args.exe.lower()) or first.endswith("/" + args.exe.lower()) or first == args.exe.lower():
            return int(p)
    return None

out = open(args.out, "w", buffering=1)
pid = None
while pid is None:
    pid = find_pid()
    if pid is None: time.sleep(0.2)
out.write(f"# pid={pid} cmd={open(f'/proc/{pid}/cmdline','rb').read()!r}\n")
fd = os.open(f"/proc/{pid}/mem", os.O_RDONLY)
def exe_base():
    for _ in range(100):
        for line in open(f"/proc/{pid}/maps"):
            if line.rstrip().lower().endswith(args.exe.lower()):
                return int(line.split("-")[0], 16)
        time.sleep(0.1)
    return 0x400000
EB = exe_base()
out.write(f"# exe_base=0x{EB:x}\n")
regs = []
for r in args.region:
    label, addr, deref, size = r.split(":")
    a = EB + int(addr[4:], 16) if addr.startswith("exe+") else int(addr, 16)
    regs.append((label, a, deref == "1", int(size, 16)))
last = {}
trig = None
if args.trigger:
    tl, ti, tv = args.trigger.split(":")
    trig = (tl, int(ti), int(tv))
scan_vals = [int(v) for v in args.scan.split(",") if v]
scanned = False

def rd(addr, size):
    try:
        return os.pread(fd, size, addr)
    except OSError:
        return None

def scan():
    maps = open(f"/proc/{pid}/maps").read().splitlines()
    fmt = {4: "<I", 8: "<Q"}[args.scan_width]
    needles = {v: struct.pack(fmt, v) for v in scan_vals}
    hits = []
    for line in maps:
        m = re.match(r"([0-9a-f]+)-([0-9a-f]+) (\S+)", line)
        a, b, perm = int(m[1], 16), int(m[2], 16), m[3]
        if "r" not in perm or "w" not in perm or b - a > 512 * 1024 * 1024 or a > 0x7fffffffffff: continue
        data = rd(a, b - a)
        if not data: continue
        for v, n in needles.items():
            i = data.find(n)
            while i >= 0:
                hits.append((v, a + i))
                i = data.find(n, i + 1)
    for v, addr in hits:
        out.write(f"SCANHIT value={v} addr=0x{addr:08x}\n")
    out.write(f"SCANDONE hits={len(hits)}\n")

t0 = time.time()
n = 0
while True:
    if not os.path.exists(f"/proc/{pid}"):
        out.write("# process exited\n"); break
    now = time.time()
    for label, addr, deref, size in regs:
        base = addr
        if deref:
            p = rd(addr, 4)
            if p is None: continue
            base = struct.unpack("<I", p)[0]
            if base == 0: continue
        data = rd(base, size)
        if data is None: continue
        ints = struct.unpack(f"<{size//4}i", data[: size // 4 * 4])
        prev = last.get(label)
        if prev != ints:
            if prev is None:
                out.write(f"{now:.4f} {label} base=0x{base:08x} FULL " + " ".join(f"{i:x}={v}" for i, v in enumerate(ints)) + "\n")
            else:
                ch = [f"{i:x}={v}" for i, (a, v) in enumerate(zip(prev, ints)) if a != v]
                out.write(f"{now:.4f} {label} " + " ".join(ch) + "\n")
            last[label] = ints
        if trig and not scanned and label == trig[0] and ints[trig[1]] == trig[2]:
            out.write(f"{now:.4f} TRIGGER\n"); scan(); scanned = True
    n += 1
    time.sleep(0.0005)
