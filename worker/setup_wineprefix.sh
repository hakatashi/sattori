#!/usr/bin/env bash
# 東方録画用WINEPREFIXの作成・更新。
#
# 新規作成の場合は32bitプレフィックスを初期化した上で、既存プレフィックスの
# 更新の場合はそのまま、MS Gothicフォントの配置とレジストリ登録
# (touhou-recorder reports/13, reports/29)を行う。
#
# msgothic.ttc(実際のMS Gothic/MS PGothic/MS UI Gothicを含むTrueTypeコレクション)
# はライセンス上リポジトリに含められないため、Windows実機等から別途用意すること。
#
# Usage: setup_wineprefix.sh <prefix-path> <msgothic.ttc-path>
# Example: setup_wineprefix.sh worker/prefixes/th08-wined3d-gl games/assets/msgothic.ttc

set -euo pipefail

PREFIX_PATH="${1:?usage: setup_wineprefix.sh <prefix-path> <msgothic.ttc-path>}"
MSGOTHIC_PATH="${2:?usage: setup_wineprefix.sh <prefix-path> <msgothic.ttc-path>}"

if [[ ! -f "$MSGOTHIC_PATH" ]]; then
  echo "msgothic.ttc not found: $MSGOTHIC_PATH" >&2
  exit 1
fi

if [[ ! -d "$PREFIX_PATH" ]]; then
  echo "Initializing new WINEPREFIX at $PREFIX_PATH (WINEARCH=win32)"
  WINEARCH=win32 WINEPREFIX="$PREFIX_PATH" wineboot -u
  WINEPREFIX="$PREFIX_PATH" wineserver -w
else
  echo "Reusing existing WINEPREFIX at $PREFIX_PATH"
fi

FONTS_DIR="$PREFIX_PATH/drive_c/windows/Fonts"
mkdir -p "$FONTS_DIR"
cp "$MSGOTHIC_PATH" "$FONTS_DIR/msgothic.ttc"

export WINEPREFIX="$PREFIX_PATH"

# th07.exe/th08.exeはGDIのフォント名指定にShift_JISで"ＭＳ ゴシック"をハードコードしている
# (touhou-recorder reports/13)。FontSubstitutesの日本語名→英語名マッピングと、
# Fontsキーへの実ファイル登録の両方が揃って初めて正しく解決される。
wine reg add "HKLM\Software\Microsoft\Windows NT\CurrentVersion\Fonts" /v "MS Gothic (TrueType)" /d "msgothic.ttc" /f
wine reg add "HKLM\Software\Microsoft\Windows NT\CurrentVersion\Fonts" /v "MS PGothic (TrueType)" /d "msgothic.ttc" /f
wine reg add "HKLM\Software\Microsoft\Windows NT\CurrentVersion\Fonts" /v "MS UI Gothic (TrueType)" /d "msgothic.ttc" /f

wine reg add "HKLM\Software\Microsoft\Windows NT\CurrentVersion\FontSubstitutes" /v "ＭＳ ゴシック" /d "MS Gothic" /f
wine reg add "HKLM\Software\Microsoft\Windows NT\CurrentVersion\FontSubstitutes" /v "ＭＳ Ｐゴシック" /d "MS PGothic" /f

WINEPREFIX="$PREFIX_PATH" wineserver -w

echo "Done: $PREFIX_PATH"
