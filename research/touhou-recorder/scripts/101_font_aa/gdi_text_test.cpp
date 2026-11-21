// フェーズ101: Wine上のGDIテキスト描画が二値(埋め込みビットマップ)になる条件を切り分ける最小テスト。
// 使い方: gdi_text_test.exe <out.pgm> [face] [quality] [weight]
//   heights 12..32 の各サイズで「お前はここで終わりだがな！」をTextOutWで白地に黒で描き、
//   1枚のPGM(8bitグレー)に縦に並べて出力する。
// ビルド: i686-w64-mingw32-g++ -O2 -static -municode -finput-charset=UTF-8 -o gdi_text_test.exe gdi_text_test.cpp -lgdi32
#include <windows.h>
#include <cstdio>
#include <cwchar>
#include <cstdlib>

int wmain(int argc, wchar_t **argv) {
  if (argc < 2) return 1;
  const wchar_t *face = argc > 2 ? argv[2] : L"ＭＳ ゴシック";
  int quality = argc > 3 ? _wtoi(argv[3]) : ANTIALIASED_QUALITY;
  int weight = argc > 4 ? _wtoi(argv[4]) : FW_NORMAL;
  const wchar_t *text = L"お前はここで終わりだがな！おやおや";
  const int W = 640, ROWH = 36, H0 = 12, H1 = 32, N = H1 - H0 + 1, H = ROWH * N;
  HDC dc = CreateCompatibleDC(nullptr);
  BITMAPINFO bi = {};
  bi.bmiHeader.biSize = sizeof(bi.bmiHeader);
  bi.bmiHeader.biWidth = W; bi.bmiHeader.biHeight = -H;
  bi.bmiHeader.biPlanes = 1; bi.bmiHeader.biBitCount = 32; bi.bmiHeader.biCompression = BI_RGB;
  void *bits = nullptr;
  HBITMAP bmp = CreateDIBSection(dc, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
  SelectObject(dc, bmp);
  memset(bits, 0xFF, W * H * 4);
  SetBkMode(dc, TRANSPARENT);
  SetTextColor(dc, RGB(0, 0, 0));
  for (int i = 0; i < N; i++) {
    int h = H0 + i;
    HFONT f = CreateFontW(h, 0, 0, 0, weight, 0, 0, 0, SHIFTJIS_CHARSET, OUT_DEFAULT_PRECIS,
                          CLIP_DEFAULT_PRECIS, quality, FIXED_PITCH | FF_MODERN, face);
    HGDIOBJ old = SelectObject(dc, f);
    TextOutW(dc, 2, i * ROWH + 2, text, (int)wcslen(text));
    SelectObject(dc, old);
    DeleteObject(f);
  }
  GdiFlush();
  FILE *fp = _wfopen(argv[1], L"wb");
  fprintf(fp, "P5\n%d %d\n255\n", W, H);
  unsigned char *p = (unsigned char *)bits;
  for (int i = 0; i < W * H; i++) fputc(p[i * 4 + 1], fp);
  fclose(fp);
  return 0;
}
