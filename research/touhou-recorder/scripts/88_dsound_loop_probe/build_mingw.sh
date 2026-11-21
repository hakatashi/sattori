#!/usr/bin/env bash
# フェーズ88: ループ再生クリック源プローブのビルド(32bit、ゲームと同じPE32で揃える)。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
i686-w64-mingw32-g++ -O2 -static -static-libgcc -static-libstdc++ \
  -o dsloop.exe dsloop.cpp -ldsound -ldxguid -lole32 -luuid -lwinmm
echo "built: $(pwd)/dsloop.exe"
