# Windows 実機での追加検証の依頼(touhou-recorder フェーズ101)

あなたは Windows 実機で動くコーディングエージェントです。Linux マシン(HakataMatrix)で進めている調査の裏付けとして、Windows 実機で東方神霊廟(th13)を動かして、いくつかのデータを採取・解析してください。

## リポジトリへのアクセス

調査対象のリポジトリは HakataMatrix 上にあり、SMB で読み書きできます。

```
\\hakatamatrix\hakatashi\Documents\GitHub\touhou-recorder
```

(Linux 側のパスは `/home/hakatashi/Documents/GitHub/touhou-recorder`。以下、リポジトリ相対パスで書きます。)

- 最初に `reports/101_phase101_jaggy_text_d3dx_filter.md` を読んで、ここまでの経緯を把握してください。
- **git の操作(commit・push・checkout 等)はしないでください。** Linux 側で作業中のため、衝突します。
- リポジトリへの書き込みは、結果の置き場所 `runs\101_windows\` の中だけにしてください。

## 背景(要約)

Wine で録画した th13 の会話文が、Windows 実機よりジャギーに見える問題を調べています。Linux 側の調査で次のことが分かっています。

1. th13 は会話文を GDI(`CreateFontA` の MS ゴシック height=32、`ANTIALIASED_QUALITY`、黒文字・背景透過)で、1024x129・16bpp・`BI_BITFIELDS`(R=0x0F00, G=0x00F0, B=0x000F)の DIB に描く。描く前に文字の範囲を `0xF000` で塗っておき、GDI が文字の画素を書くとマスク外の上位 4bit(=アルファ)が 0 になる。Wine では、描画後の値は `0xF000→0x0000` の二値だけだった。
2. その DIB を `D3DXLoadSurfaceFromMemory(..., srcRect=1024x44, dstRect=512x20, Filter=D3DX_FILTER_TRIANGLE)` で A4R4G4B4 のテクスチャへ縮小転送する。Wine 内蔵の d3dx9 は TRIANGLE を実装しておらず、最近傍で縮小するため文字が二値のまま表示される。
3. Microsoft の `d3dx9_43.dll` を Wine で読み込ませると、Windows 実機とほぼ同じ見た目になった。MOD 側のテント縮小(`D3DX_AREA_FILTER=1`)の出力は、そのネイティブ DLL の出力と 4bit アルファで 97〜98% 一致した。

Windows 実機で確かめたいのは、次の 3 点です。

- **(A)** Windows の GDI でも、1 の DIB は二値になるか(GDI の AA が結果に影響しないか)。
- **(B)** Windows 実機の `d3dx9_43.dll` の縮小結果が、Linux で Wine + ネイティブ DLL を使ったときの結果と同じか。また、MOD 側のテント縮小とどれだけ違うか。
- **(C)** Windows の GDI は、小さい MS ゴシック(weight 400、`ANTIALIASED_QUALITY`、height 12〜20)を二値で描くか(Wine は gasp テーブルに従って二値に落とす)。th13 には関係しないが、他タイトルの判断材料にする。

## 準備

1. 作業フォルダをローカルに作る(例: `C:\th13-101`)。ゲームは SMB 上から直接起動せず、ローカルにコピーして使ってください。
2. 次をコピーする。
   - `games\th13\` の中身すべて → `C:\th13-101\game\`(`th13.exe`・`th13.dat`・`thbgm.dat` 等。著作権物なので、このフォルダの外へ配布しないこと)
   - `mods\common\build\injector.exe` → `C:\th13-101\game\`
   - `mods\th13_replay_autoplay\build\th13_hook.dll` → `C:\th13-101\game\`
   - `scripts\101_font_aa\gdi_text_test.exe` → `C:\th13-101\`
3. **ユーザーのセーブデータを退避する。** th13 は設定とリプレイを `%APPDATA%\ShanghaiAlice\th13\` から読む。フォルダがあれば丸ごと別名でコピーしておき、作業の最後に必ず元に戻すこと。
4. `%APPDATA%\ShanghaiAlice\th13\` を次の状態にする。
   - `games\th13\th13.cfg` → `%APPDATA%\ShanghaiAlice\th13\th13.cfg`(ウィンドウモード設定)
   - `games\th13\replay\th13_06.rpy` → `%APPDATA%\ShanghaiAlice\th13\replay\th13_ud0000.rpy`(MOD はユーザーリプレイの先頭スロットを選ぶ)
5. Python 3 と numpy・Pillow を用意する(無ければ `pip install --user numpy pillow`)。解析スクリプトは `scripts\101_font_aa\` にある。

## ゲームの起動方法

MOD(`th13_hook.dll`)がタイトル画面から自動でリプレイを再生する(起動後 10 秒待ってから、DirectInput の入力を注入して Down x3 → Enter → Right → Enter → Enter)。MOD の動作は環境変数で切り替える。`injector.exe` が作るゲームのプロセスは、起動したコマンドプロンプトの環境変数を引き継ぐ。

```bat
cd /d C:\th13-101\game
set 環境変数...(各手順を参照)
injector.exe th13.exe th13_hook.dll
```

- 起動中はゲームのウィンドウを前面に置き、キーボードやマウスに触らないこと(入力の注入がずれる)。
- 最初の会話は、起動から約 70 秒後に始まる(「あーあ、あんな奴ら復活させちゃってさ」など)。各手順は**起動から 120 秒たったら**ゲームを終了してよい(`taskkill /im th13.exe /f`)。
- MOD のログは `C:\th13-101\game\th13_autoplay.log` に追記される。手順ごとに結果フォルダへコピーしてから消すこと。
- ダンプ先フォルダは事前に作っておくこと(無いと書き出されない)。

## 手順

結果はすべて `\\hakatamatrix\hakatashi\Documents\GitHub\touhou-recorder\runs\101_windows\` に置いてください(以下 `OUT`)。

### (A) GDI で描いた直後の DIB

```bat
mkdir C:\th13-101\dib
set FONT_QUALITY_PROBE=1
set FONT_PROBE_DUMP_DIR=C:\th13-101\dib
injector.exe th13.exe th13_hook.dll
```

120 秒後に終了し、`C:\th13-101\dib\`(`textout_NN_pre.bin`/`_post.bin`)とログを `OUT\dib\` にコピーする。解析:

```bat
python scripts\101_font_aa\analyze_dib_dumps.py OUT\dib
python scripts\101_font_aa\analyze_dib_dumps.py runs\101_linux_dumps\dib
```

確認すること:
- `after=` に `0x0` 以外(中間値)が出るか。Wine では `0xf000 → 0x0` だけだった。
- ログの `CreateDIBSection:` 行のサイズ・マスク、`TextOutA:` 行の h/w/q/color/bkmode が Wine と同じか。Wine では `1024x-129 bpp=16 compression=3 masks=00000F00,000000F0,0000000F`、台詞は `h=32 w=400 q=4 color=000000 bkmode=1`。

### (B) d3dx9 の縮小結果

まず、使われる `d3dx9_43.dll` の版を記録する(32bit なので `SysWOW64`)。

```powershell
(Get-Item C:\Windows\SysWOW64\d3dx9_43.dll).VersionInfo | Format-List FileVersion,ProductVersion
Get-FileHash C:\Windows\SysWOW64\d3dx9_43.dll
```

(B-1) Windows のネイティブ d3dx9 の出力:

```bat
mkdir C:\th13-101\xfer_win_native
set FONT_QUALITY_PROBE=
set FONT_PROBE_DUMP_DIR=
set D3DX_LOAD_PROBE=1
set D3DX_DUMP_DIR=C:\th13-101\xfer_win_native
injector.exe th13.exe th13_hook.dll
```

(B-2) 同じく MOD 側のテント縮小(`D3DX_AREA_FILTER=1`、既定の半径 0.8):

```bat
mkdir C:\th13-101\xfer_win_tent
set D3DX_AREA_FILTER=1
set D3DX_DUMP_DIR=C:\th13-101\xfer_win_tent
injector.exe th13.exe th13_hook.dll
```

それぞれ `OUT\xfer_win_native\`・`OUT\xfer_win_tent\` にコピー(ログも)。解析(転送元の中身が同じ転送どうしを対応させて比べる):

```bat
python scripts\101_font_aa\compare_xfer_dumps.py OUT\xfer_win_native runs\101_linux_dumps\xfer_native
python scripts\101_font_aa\compare_xfer_dumps.py OUT\xfer_win_native OUT\xfer_win_tent --png OUT\cmp_native_tent
python scripts\101_font_aa\compare_xfer_dumps.py OUT\xfer_win_native runs\101_linux_dumps\xfer_tent
python scripts\101_font_aa\compare_xfer_dumps.py OUT\xfer_win_native runs\101_linux_dumps\xfer_area
```

確認すること:
- Windows ネイティブと Linux(Wine + ネイティブ DLL)の出力が完全一致するか(`exact=1.000` が期待値)。`same source: 0` なら転送元が Windows と Linux で違う。その場合は (A) の結果とあわせて原因を書くこと(GDI の描画結果の違いが考えられる)。
- Windows ネイティブとテント縮小の一致率(Linux では exact 0.971〜0.984、全画素が 1 段階以内)。
- 余裕があれば、`set D3DX_AREA_FILTER_RADIUS=0.7` や `0.9` で (B-2) を繰り返し、一致率が最大になる半径を探す。

### (C) 小さい MS ゴシックの GDI 描画

```bat
cd /d C:\th13-101
gdi_text_test.exe w400_q4.pgm "ＭＳ ゴシック" 4 400
gdi_text_test.exe w700_q4.pgm "ＭＳ ゴシック" 4 700
gdi_text_test.exe w400_q0.pgm "ＭＳ ゴシック" 0 400
gdi_text_test.exe w400_q5.pgm "ＭＳ ゴシック" 5 400
```

(引数: 出力 PGM、フォント名、lfQuality、weight。height 12〜32 の行を縦に並べる。)PGM を `OUT\gdi\` にコピーし:

```bat
python scripts\101_font_aa\analyze_gdi_pgm.py OUT\gdi\w400_q4.pgm OUT\gdi\w700_q4.pgm OUT\gdi\w400_q0.pgm OUT\gdi\w400_q5.pgm
python scripts\101_font_aa\analyze_gdi_pgm.py runs\101_linux_dumps\gdi\w400_q4.pgm runs\101_linux_dumps\gdi\w700_q4.pgm
```

Wine では `w400_q4` の height 12〜20 が 2 階調(二値)、21 以上と `w700_q4` は全行 16 階調だった。Windows で height 12〜20 が二値になるか(gasp に従うか)を確認する。PGM を PNG にして目視確認した画像も添えること。なお、Windows の設定(ClearType・フォントの滑らかさ)を記録しておくこと(`q0` の結果はこれに左右される)。

## 報告

`OUT\RESULT.md` に次をまとめてください。

- 実行環境(Windows のバージョン、`d3dx9_43.dll` の版・ハッシュ、ClearType の設定、GPU)
- (A)(B)(C) それぞれの実行コマンドと、解析スクリプトの出力そのもの
- 各問いへの答え(Wine の結果と同じか違うか、違うならどう違うか)と、そこから言えること
- 予定どおりにいかなかったこと(MOD が動かない、リプレイの再生がずれた等)とその対処

最後に、退避した `%APPDATA%\ShanghaiAlice\th13\` を元に戻したこと、th13.exe が残っていないことを確認してから終了してください。
