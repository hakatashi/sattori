#!/usr/bin/env python3
"""th20.exe(v1.00c想定)の点アイテム得点計算 RVA 0xC49A7 の32bit乗算を64bit乗算へ書き換える。
thprac の th20_piv_overflow_fix と同じ計算 (int64)piv_base*piv/piv_divisor + piv_base/2 になる。"""
import os, struct, sys, time

RVA = 0xC49A7
ORIG = bytes.fromhex("0faff86a00e8cff6f9ff83c4048bc8e84539ffff8bc88bc799f7f903f0")
assert len(ORIG) == 29

def rel(addr_next, target):
    return struct.pack("<i", target - addr_next)

def build(base):
    a = base + RVA
    code = bytearray()
    code += bytes.fromhex("8945dc")            # mov [ebp-0x24], eax   (piv_base)
    code += bytes.fromhex("6a00")              # push 0
    code += b"\xe8" + rel(a + len(code) + 5, base + 0x64080)
    code += bytes.fromhex("59")                # pop ecx
    code += bytes.fromhex("8bc8")              # mov ecx, eax
    code += b"\xe8" + rel(a + len(code) + 5, base + 0xB8300)   # -> eax = piv_divisor
    code += bytes.fromhex("8bc8")              # mov ecx, eax
    code += bytes.fromhex("8b45dc")            # mov eax, [ebp-0x24]
    code += bytes.fromhex("f7ef")              # imul edi  (edx:eax = piv_base * piv)
    code += bytes.fromhex("f7f9")              # idiv ecx
    code += bytes.fromhex("03f0")              # add esi, eax
    assert len(code) == 29, len(code)
    return bytes(code)

EXCLUDE = {int(x) for x in sys.argv[1:]}
def find_pid():
    for p in os.listdir("/proc"):
        if not p.isdigit() or int(p) in EXCLUDE: continue
        try: cmd = open(f"/proc/{p}/cmdline", "rb").read().split(b"\0")[0].decode(errors="replace").lower()
        except OSError: continue
        if cmd.endswith("\\th20.exe"): return int(p)

pid = None
while pid is None:
    pid = find_pid(); time.sleep(0.05)
base = None
while base is None:
    for line in open(f"/proc/{pid}/maps"):
        if line.rstrip().lower().endswith("th20.exe"):
            base = int(line.split("-")[0], 16); break
    time.sleep(0.05)
fd = os.open(f"/proc/{pid}/mem", os.O_RDWR)
for _ in range(200):
    cur = os.pread(fd, 29, base + RVA)
    # 再配置(ASLR)されていれば rel32 が変わらないので ORIG と比較できる
    if cur == ORIG: break
    time.sleep(0.05)
print(f"pid={pid} base=0x{base:x} cur={cur.hex()}")
if cur != ORIG:
    print("ORIGINAL BYTES MISMATCH, abort"); sys.exit(1)
patch = build(base)


os.pwrite(fd, patch, base + RVA)
print("PATCHED", os.pread(fd, 29, base + RVA).hex())
