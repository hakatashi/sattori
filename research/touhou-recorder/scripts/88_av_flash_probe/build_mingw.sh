#!/usr/bin/env bash
# フェーズ88: A/V同期の合成プローブのビルド(32bit)。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
i686-w64-mingw32-g++ -O2 -static -static-libgcc -static-libstdc++ \
  -o avflash.exe avflash.cpp -ldsound -ldxguid -lole32 -luuid -lwinmm -lgdi32 -luser32
echo "built: $(pwd)/avflash.exe"
