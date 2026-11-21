#!/usr/bin/env bash
# th15向けMODの32bitクロスビルド。
#
# 以前はここにソース一覧を持っていたが、共通フックの追加(d3dx_filter_hook、reports/101)に
# 追随できずリンクエラーになっていた。mods/common/*.cpp をまとめてリンクする共通スクリプト
# (mods/common/build_mingw.sh、フェーズ88)へ委譲する。
#
# 生成物: mods/th15_replay_autoplay/build/th15_hook.dll
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec "$REPO/mods/common/build_mingw.sh" th15
