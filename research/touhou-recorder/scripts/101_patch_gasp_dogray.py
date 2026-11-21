#!/usr/bin/env python3
"""フェーズ101: TrueType(.ttf/.ttc)の gasp テーブルの全レンジに GASP_DOGRAY(0x0002) を立てる。

Wine(win32u/freetype.c freetype_get_aa_flags)は ANTIALIASED_QUALITY を明示したフォントでも、
gasp で DOGRAY の無い ppem では二値(GGO_BITMAP)に格下げし、その結果 FreeType が埋め込み
ビットマップ(EBDT)を使う。MS ゴシックは 9〜20ppem が flags=5(DOGRAY 無し)のため、
このサイズのゲーム内テキストが二値のジャギーな文字になる(reports/101)。

Usage: python3 scripts/101_patch_gasp_dogray.py <in.ttc> <out.ttc>
"""
import sys
from fontTools.ttLib import TTCollection, TTFont

GASP_DOGRAY = 0x0002


def patch(font):
    if "gasp" not in font:
        return None
    before = dict(font["gasp"].gaspRange)
    font["gasp"].gaspRange = {k: v | GASP_DOGRAY for k, v in before.items()}
    return before, dict(font["gasp"].gaspRange)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    if src.lower().endswith(".ttc"):
        coll = TTCollection(src)
        fonts = coll.fonts
    else:
        coll = TTFont(src)
        fonts = [coll]
    for f in fonts:
        r = patch(f)
        print(f["name"].getDebugName(4), r)
    coll.save(dst)


if __name__ == "__main__":
    main()
