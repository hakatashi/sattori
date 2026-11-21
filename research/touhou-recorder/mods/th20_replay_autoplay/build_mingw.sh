#!/usr/bin/env bash
# th20向けMOD・injectorの32bitクロスビルド(reports/99で追加。build.batはspeed_hack_hookが漏れており古い)。
#
# th20.exe は PE32 (x86) なので i686-w64-mingw32 ツールチェーンを使う。
# 既存の build.bat (MSVC / Windows上でのビルド) と等価な成果物を Linux 上から作る。
# フェーズ85でspeed_hack_hook等を追加した際、build.batの更新が漏れたまま
# アドホックなmingwビルドで運用されていたため、ここに手順を固定する。
#
# 生成物:
#   mods/th20_replay_autoplay/build/th20_hook.dll  リプレイ自動再生MOD
#
# -static / -static-libgcc / -static-libstdc++ は必須(付けないとDLL注入自体が
# 失敗する。AGENTS.md参照)。
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CXX=i686-w64-mingw32-g++
COMMON_FLAGS=(-O2 -static -static-libgcc -static-libstdc++
              -finput-charset=UTF-8 -fexec-charset=UTF-8 -fwide-exec-charset=UTF-16LE)

mkdir -p "$REPO/mods/th20_replay_autoplay/build"

"$CXX" -shared "${COMMON_FLAGS[@]}" \
  -o "$REPO/mods/th20_replay_autoplay/build/th20_hook.dll" \
  "$REPO/mods/th20_replay_autoplay/dllmain.cpp" \
  "$REPO/mods/common/dinput_hook.cpp" \
  "$REPO/mods/common/window_wait.cpp" \
  "$REPO/mods/common/logging.cpp" \
  "$REPO/mods/common/fps_monitor.cpp" \
  "$REPO/mods/common/fps_limiter_hook.cpp" \
  "$REPO/mods/common/fps_display_hook.cpp" \
  "$REPO/mods/common/speed_hack_hook.cpp" \
  "$REPO/mods/common/dsound_hook.cpp" \
  "$REPO/mods/common/stage_probe_hook.cpp" \
  "$REPO/mods/common/stage_marker_hook.cpp" \
  "$REPO/mods/common/stage_marker_io.cpp" \
  "$REPO/mods/common/score_monitor.cpp" \
  "$REPO/mods/common/d3d9_probe_hook.cpp" \
  -luser32

echo "built: $REPO/mods/th20_replay_autoplay/build/th20_hook.dll"
