#!/usr/bin/env python3
"""画面上fps表示の計算に使われているタイマー呼び出しの候補を探す(フェーズ90)。

32bitのゲームexeについて、
  - fps書式文字列(例: "%.02ffps"、"%2.1ffps")を参照する命令
  - QueryPerformanceCounter/timeGetTime/GetTickCount等のIATを参照する命令と、その戻り先RVA
をアドレス順に列挙する。fps文字列を参照する関数の近く(またはその関数が呼ぶ時刻取得関数)に
あるタイマー呼び出しの戻り先RVAが、mods/common/fps_display_hook の対象候補になる。
--disasm START END(RVA、16進)で区間の逆アセンブルも出せる。

Usage:
  python3 scripts/90_find_fps_timer_callsites.py games/th08_ver100d/th08.exe
  python3 scripts/90_find_fps_timer_callsites.py games/th06/東方紅魔郷.exe --disasm 0x23f3f 0x24000
"""
import argparse
import re

import capstone
import pefile

TIMERS = ("QueryPerformanceCounter", "QueryPerformanceFrequency", "timeGetTime", "GetTickCount")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("exe")
    ap.add_argument("--disasm", nargs=2, metavar=("START", "END"))
    args = ap.parse_args()

    pe = pefile.PE(args.exe)
    base = pe.OPTIONAL_HEADER.ImageBase
    data = pe.get_memory_mapped_image()
    md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
    md.skipdata = True

    if args.disasm:
        a, b = (int(x, 16) for x in args.disasm)
        for ins in md.disasm(data[a:b], base + a):
            print(hex(ins.address - base), ins.mnemonic, ins.op_str)
        return

    timers = {imp.address: imp.name.decode()
              for e in pe.DIRECTORY_ENTRY_IMPORT for imp in e.imports
              if imp.name and imp.name.decode() in TIMERS}
    fpsva = [base + m.start() for m in re.finditer(rb"%[0-9.]*f ?fps", data)]
    print("fps strings:", [hex(v) for v in fpsva])
    text = [s for s in pe.sections if s.Characteristics & 0x20000000][0]
    code = data[text.VirtualAddress:text.VirtualAddress + text.Misc_VirtualSize]
    for ins in md.disasm(code, base + text.VirtualAddress):
        s = ins.op_str
        for v in fpsva:
            if hex(v) in s:
                print("FPSREF", hex(ins.address - base), ins.mnemonic, s)
        for a, n in timers.items():
            if hex(a) in s:
                print("TIMER", n, "ins_rva", hex(ins.address - base),
                      "ret_rva", hex(ins.address + ins.size - base), ins.mnemonic, s)


if __name__ == "__main__":
    main()
