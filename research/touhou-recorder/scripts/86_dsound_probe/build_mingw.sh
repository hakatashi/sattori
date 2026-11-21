#!/usr/bin/env bash
# DirectSound単体プローブ(フェーズ86)の32bitクロスビルド。
#
# 倍速録画時にWineのDirectSound/winepulse経路が実際に何Hzでミックス・出力するかを
# ゲーム本体を起動せずに測るための最小構成のWin32アプリ。詳細は
# reports/86_phase86_doublespeed_audio_bandwidth_root_cause.md §1 を参照。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
i686-w64-mingw32-g++ -O2 -static -static-libgcc -static-libstdc++ \
  -o dsprobe.exe dsprobe.cpp -ldsound -ldxguid -lole32 -luuid -lwinmm
echo "built: $(pwd)/dsprobe.exe"
