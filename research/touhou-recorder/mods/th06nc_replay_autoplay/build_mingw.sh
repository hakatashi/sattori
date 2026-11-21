#!/usr/bin/env bash
# th06nc向けMOD・スタブ・injectorの64bitクロスビルド(フェーズ78)。
#
# th06nc.exe は PE32+ (x86-64) なので、既存タイトル用の32bitビルド
# (mods/*/build.bat、i686-w64-mingw32) はそのまま使えない。ここでは
# mingw-w64 の x86_64 ツールチェーンでLinux上からクロスビルドする。
#
# 生成物:
#   mods/th06nc_replay_autoplay/build/th06nc_hook.dll  リプレイ自動再生MOD
#   mods/th06c_steam_stub/build/steam_api64.dll       Steamworks APIスタブ(th06cと共用)
#   mods/common/build/injector64.exe                 64bit版DLLインジェクター
#
# -static / -static-libgcc / -static-libstdc++ は必須(付けないとDLL注入自体が
# 失敗する。AGENTS.md参照)。日本語のワイド文字リテラルを使うため
# -fwide-exec-charset=UTF-16LE も明示する。

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CXX=x86_64-w64-mingw32-g++
COMMON_FLAGS=(-O2 -static -static-libgcc -static-libstdc++
              -finput-charset=UTF-8 -fexec-charset=UTF-8 -fwide-exec-charset=UTF-16LE)

mkdir -p "$REPO/mods/th06nc_replay_autoplay/build" \
         "$REPO/mods/th06c_steam_stub/build" \
         "$REPO/mods/common/build"

echo "[1/3] th06nc_hook.dll"
"$CXX" -shared "${COMMON_FLAGS[@]}" \
  -o "$REPO/mods/th06nc_replay_autoplay/build/th06nc_hook.dll" \
  "$REPO/mods/th06nc_replay_autoplay/dllmain.cpp" \
  "$REPO/mods/common/logging.cpp" \
  "$REPO/mods/common/dsound_hook.cpp" \
  "$REPO/mods/common/speed_hack_hook.cpp" \
  "$REPO/mods/common/wasapi_hook.cpp" \
  "$REPO/mods/common/d3d11_bc7_hook.cpp" \
  "$REPO/mods/common/frame_sync_d3d11.cpp" \
  "$REPO/mods/common/frame_sync_wasapi.cpp" \
  -luser32 -lole32 -ldxguid -lwinmm

echo "[2/3] steam_api64.dll (スタブ、th06cと共用)"
"$CXX" -shared "${COMMON_FLAGS[@]}" \
  -o "$REPO/mods/th06c_steam_stub/build/steam_api64.dll" \
  "$REPO/mods/th06c_steam_stub/steam_api_stub.cpp"

echo "[3/3] injector64.exe"
"$CXX" "${COMMON_FLAGS[@]}" \
  -o "$REPO/mods/common/build/injector64.exe" \
  "$REPO/mods/common/injector.cpp"

echo "Done."
