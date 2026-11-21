#!/usr/bin/env bash
# 32bitタイトル向けMODを Linux上の i686-w64-mingw32 でクロスビルドする(フェーズ88)。
#
# 各タイトルの build.bat(MSVC用)のソース一覧は、後から追加された共通フック
# (stage_probe_hook・speed_hack_hook等)に追随していないものが多く、そのままでは
# リンクできない(th15は reports/86 で同じ理由から build_mingw.sh を別途用意した)。
# そこで「タイトルの dllmain.cpp + mods/common/*.cpp 全部(injector.cpp を除く)」を
# まとめてリンクする。未使用のフックは --gc-sections で落ちる。
#
# Usage: mods/common/build_mingw.sh th10
#   出力: mods/th10_replay_autoplay/build/th10_hook.dll
# -static / -static-libgcc / -static-libstdc++ は必須(付けないとDLL注入自体が失敗する)。
set -euo pipefail

TITLE="$1"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIR="$REPO/mods/${TITLE}_replay_autoplay"
CXX=i686-w64-mingw32-g++

srcs=("$DIR"/*.cpp)
for s in "$REPO"/mods/common/*.cpp; do
  [[ "$(basename "$s")" == injector.cpp ]] && continue
  srcs+=("$s")
done

mkdir -p "$DIR/build"
"$CXX" -shared -O2 -static -static-libgcc -static-libstdc++ \
  -ffunction-sections -fdata-sections -Wl,--gc-sections \
  -finput-charset=UTF-8 -fexec-charset=UTF-8 -fwide-exec-charset=UTF-16LE \
  -o "$DIR/build/${TITLE}_hook.dll" "${srcs[@]}" -luser32 -lwinmm -lgdi32
echo "built: $DIR/build/${TITLE}_hook.dll"
