#!/usr/bin/env bash
# 東方録画用WINEPREFIXの作成・更新。
#
# 新規作成の場合は32bitプレフィックスを初期化した上で、既存プレフィックスの
# 更新の場合はそのまま、MS Gothicフォントの配置とレジストリ登録
# (touhou-recorder reports/13, reports/29)を行う。第3引数でmsmincho.ttcを渡すと
# MS明朝の配置・レジストリ登録も追加で行う(th11のNPC会話シーン等で使われる。
# 未指定ならスキップする、touhou-recorder reports/38)。
#
# msgothic.ttc/msmincho.ttc(実際のMS Gothic/MS PGothic/MS UI Gothicおよび
# MS Mincho/MS PMinchoを含むTrueTypeコレクション)はライセンス上リポジトリに
# 含められないため、Windows実機等から別途用意すること。
#
# Usage: setup_wineprefix.sh <prefix-path> <msgothic.ttc-path> [msmincho.ttc-path]
# Example: setup_wineprefix.sh worker/prefixes/th08-wined3d-gl games/assets/msgothic.ttc
# Example(MS明朝も登録): setup_wineprefix.sh worker/prefixes/th11-wined3d-gl games/assets/msgothic.ttc games/assets/msmincho.ttc

set -euo pipefail

PREFIX_PATH="${1:?usage: setup_wineprefix.sh <prefix-path> <msgothic.ttc-path> [msmincho.ttc-path]}"
MSGOTHIC_PATH="${2:?usage: setup_wineprefix.sh <prefix-path> <msgothic.ttc-path> [msmincho.ttc-path]}"
MSMINCHO_PATH="${3:-}"

if [[ ! -f "$MSGOTHIC_PATH" ]]; then
  echo "msgothic.ttc not found: $MSGOTHIC_PATH" >&2
  exit 1
fi

if [[ -n "$MSMINCHO_PATH" && ! -f "$MSMINCHO_PATH" ]]; then
  echo "msmincho.ttc not found: $MSMINCHO_PATH" >&2
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

if [[ -n "$MSMINCHO_PATH" ]]; then
  # th11のNPC会話シーン等はGDIのフォント名指定に"ＭＳ 明朝"を使う。実体・レジストリが
  # 無いとWineの代替フォント解決チェーンを経由して別の書体(ゴシック体寄り・半角括弧)に
  # フォールバックする(touhou-recorder reports/38)。
  cp "$MSMINCHO_PATH" "$FONTS_DIR/msmincho.ttc"
  wine reg add "HKLM\Software\Microsoft\Windows NT\CurrentVersion\Fonts" /v "MS Mincho (TrueType)" /d "msmincho.ttc" /f
  wine reg add "HKLM\Software\Microsoft\Windows NT\CurrentVersion\Fonts" /v "MS PMincho (TrueType)" /d "msmincho.ttc" /f
  wine reg add "HKLM\Software\Microsoft\Windows NT\CurrentVersion\FontSubstitutes" /v "ＭＳ 明朝" /d "MS Mincho" /f
  wine reg add "HKLM\Software\Microsoft\Windows NT\CurrentVersion\FontSubstitutes" /v "ＭＳ Ｐ明朝" /d "MS PMincho" /f
fi

WINEPREFIX="$PREFIX_PATH" wineserver -w

echo "Done: $PREFIX_PATH"
