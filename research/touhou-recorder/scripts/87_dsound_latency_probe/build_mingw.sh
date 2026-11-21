#!/usr/bin/env bash
# フェーズ87: DirectSound出力遅延プローブのビルド(32bit、th15と同じPE32で揃える)。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
i686-w64-mingw32-g++ -O2 -static -static-libgcc -static-libstdc++ \
  -o dslatency.exe dslatency.cpp -ldsound -ldxguid -lole32 -luuid -lwinmm
echo "built: $(pwd)/dslatency.exe"
