# フェーズ101 Windows 実機検証の結果

日付: 2026-11-12。依頼: `scripts/101_font_aa/WINDOWS_AGENT_PROMPT.md`。

## まとめ

| 問い | 答え |
|---|---|
| (A) Windows の GDI でも DIB は二値か | **二値だった**(`0xf000 → 0x0` のみ、中間値なし)。ただし GDI が書く画素は Wine より **2.1〜3.9% 多い**(字の縁が 1px 太い箇所がある)。字形が違うので、転送元は Windows と Linux で一致しない |
| (B) Windows の `d3dx9_43.dll` は Wine + ネイティブ DLL と同じか | **同じ(画素単位で完全一致)**。転送元が違うのでゲーム内のダンプ同士は対応付けられなかったが、Windows の `d3dx9_43.dll` を直接呼ぶオフライン再現プログラムで Linux の転送元を縮小すると、Linux(Wine + ネイティブ DLL)の転送先と全 6 転送で一致した。テント縮小(半径 0.8)との一致は Windows 上でも 0.962〜0.985、全画素 1 段階以内 |
| (C) 小さい MS ゴシックは二値か | weight 400・`ANTIALIASED_QUALITY` は **Wine と同じ**(height 12〜20 が二値、21 以上が 16 階調)。**weight 700 は違う**: Windows は 12〜20 も二値(太字の埋め込みビットマップ)、Wine は全行 16 階調で、しかも小さいサイズでは太字に見えない |

## 実行環境

- Windows 11 Home 26H2(ビルド 26340.9767。レジストリの ProductName は "Windows 10 Home")
- GPU: NVIDIA GeForce RTX 5070(ドライバ 32.0.16.1088)。ほかに仮想ディスプレイ(Virtual Desktop / Meta / Parsec)
- `C:\Windows\SysWOW64\d3dx9_43.dll`: FileVersion/ProductVersion 9.29.952.3111、1,998,168 bytes、2010-05-26、SHA-256 `0B28546BE22C71834501F7D7185EDE5D79742457331C7EE09EFC14490DD64F5F`(June 2010 再頒布物と同じ版)
- フォントの滑らかさ: `HKCU\Control Panel\Desktop` の `FontSmoothing=2`(有効)、`FontSmoothingType=2`(ClearType)、`FontSmoothingGamma=0`
- `C:\Windows\Fonts\msgothic.ttc`: 8,990,160 bytes、fontRevision 5.32、SHA-256 `4BDE3E63…4F95DB`、gasp `{9: 9, 20: 5, 65535: 11}`(Linux 側の報告と同じ)
- Python 3.14.3、numpy・Pillow は `pip install --user` で導入
- MOD: SMB 上の `mods/th13_replay_autoplay/build/th13_hook.dll`(2026-11-12 13:12、SHA-256 `995D853F…858B70`)と `mods/common/build/injector.exe`

## 準備

- 作業フォルダ `C:\th13-101\`(`game\` にゲーム一式・injector・hook DLL、`gdi_text_test.exe`)。
- `%APPDATA%\ShanghaiAlice\th13\` は `th13.bak-101-windows` へ**名前を変えて丸ごと退避**し、空のフォルダに `th13.cfg` と `replay\th13_ud0000.rpy`(= `th13_06.rpy`)だけを置いた。作業後に元に戻した(末尾)。
- 各手順は補助スクリプト(下記)で、環境変数を設定して `injector.exe th13.exe th13_hook.dll` を起動し、130 秒後に `taskkill /im th13.exe /f`。MOD のログは手順ごとに結果フォルダへコピーして消した。

### 予定どおりにいかなかったこと: ウィンドウが前面に来ずデモプレイになる

最初の 2 回は、MOD が Down x3 → Enter … を注入してもタイトル画面のカーソルが動かず、ゲームはデモプレイ(HARD の 1 面)を流していた(スクリーンショットで確認。ログの `stage=1 lives=2` はデモプレイのもの)。エージェントのシェル(バックグラウンドのプロセス)から起動したため、Windows のフォーカス奪取防止でゲームのウィンドウにフォーカスが移らず、DirectInput の入力が届いていなかったと見られる。

対処: 起動 4 秒後から、Alt キーの押下・解放を `keybd_event` で送ってから `SetForegroundWindow` でゲームのウィンドウを前面にし、以後 5 秒ごとに前面かを確かめて外れていれば戻すようにした。以降の実行はすべて正常にリプレイを再生し、起動から約 70 秒で最初の会話(「あーあ、あんな奴ら復活させちゃってさ」)に到達した。

補助スクリプト(エージェントの作業用。リポジトリには置いていない)の要点:

```powershell
$p = Start-Process C:\th13-101\game\injector.exe -ArgumentList 'th13.exe','th13_hook.dll' -WorkingDirectory C:\th13-101\game -PassThru
Start-Sleep 4
# Alt を押して離す → ShowWindow(SW_RESTORE) → SetForegroundWindow(th13 の MainWindowHandle)
# 以後 5 秒ごとに GetForegroundWindow() を確認し、外れていれば同じ操作で戻す。130 秒で taskkill /im th13.exe /f
```

## (A) GDI で描いた直後の DIB

```bat
set FONT_QUALITY_PROBE=1
set FONT_PROBE_DUMP_DIR=C:\th13-101\dib
injector.exe th13.exe th13_hook.dll
```

結果: `dib\`(`textout_NN_{pre,post}.bin`、ログ `dib\th13_autoplay.log`)。

ログ(Wine と同じ):

```
CreateDIBSection: 1024x-129 bpp=16 compression=3 masks=00000F00,000000F0,0000000F
CreateFontA: face='ＭＳ ゴシック' height=32 weight=400 quality=4 -> 4
CreateFontA: face='ＭＳ ゴシック' height=15 weight=700 quality=4 -> 4
TextOutA: (0,2) h=32 w=400 q=4 color=000000 bkmode=1 bpp=16 text='あーあ、あんな奴ら復活させちゃってさ'
TextOutA: (194,4) h=32 w=400 q=4 color=000000 bkmode=1 bpp=16 text='アンノウン「軌道不明の鬼火」'
TextOutA: (192,2) h=32 w=400 q=4 color=FFFFFF bkmode=1 bpp=16 text='アンノウン「軌道不明の鬼火」'
```

`python scripts\101_font_aa\analyze_dib_dumps.py OUT\dib`(Windows):

```
textout_01 1024x129 masks=0x0f00,0x00f0,0x000f changed=0 before=[] after=[]
textout_02 1024x129 masks=0x0f00,0x00f0,0x000f changed=0 before=[] after=[]
textout_03 1024x129 masks=0x0f00,0x00f0,0x000f changed=4834 before=['0xf000'] after=[('0x0', 4834)]
textout_04 1024x129 masks=0x0f00,0x00f0,0x000f changed=4153 before=['0xf000'] after=[('0x0', 4153)]
textout_05 1024x129 masks=0x0f00,0x00f0,0x000f changed=0 before=[] after=[]
textout_06 1024x129 masks=0x0f00,0x00f0,0x000f changed=0 before=[] after=[]
textout_07 1024x129 masks=0x0f00,0x00f0,0x000f changed=4931 before=['0xf000'] after=[('0x0', 4931)]
textout_08 1024x129 masks=0x0f00,0x00f0,0x000f changed=0 before=[] after=[]
textout_09 1024x129 masks=0x0f00,0x00f0,0x000f changed=0 before=[] after=[]
textout_10 1024x129 masks=0x0f00,0x00f0,0x000f changed=3509 before=['0xf000'] after=[('0x0', 3509)]
textout_11 1024x129 masks=0x0f00,0x00f0,0x000f changed=3848 before=['0xf000'] after=[('0x0', 3848)]
textout_12 1024x129 masks=0x0f00,0x00f0,0x000f changed=2144 before=['0xf000'] after=[('0x0', 2144)]
```

`python scripts\101_font_aa\analyze_dib_dumps.py runs\101_linux_dumps\dib`(Linux):

```
textout_03 ... changed=4730 before=['0xf000'] after=[('0x0', 4730)]
textout_04 ... changed=4103 before=['0xf000'] after=[('0x0', 4103)]
textout_07 ... changed=4801 before=['0xf000'] after=[('0x0', 4801)]
textout_10 ... changed=3418 before=['0xf000'] after=[('0x0', 3418)]
textout_11 ... changed=3732 before=['0xf000'] after=[('0x0', 3732)]
textout_12 ... changed=2076 before=['0xf000'] after=[('0x0', 2076)]
(01/02/05/06/08/09 は changed=0。全行 masks=0x0f00,0x00f0,0x000f)
```

番号ごとの文字列は Windows と Linux で同じ(同じ順に同じ台詞が描かれる)。字形を画素単位で比べた(`dib_win_vs_linux.py`、このフォルダ。「字の画素」= 上位 4bit が F→0 になった画素):

```
python runs\101_windows\dib_win_vs_linux.py runs\101_windows\dib runs\101_linux_dumps\dib runs\101_windows\dib_cmp
textout_03: pre_identical=True win=4834 linux=4730 both=4717 win_only=117 linux_only=13
textout_04: pre_identical=True win=4153 linux=4103 both=4043 win_only=110 linux_only=60
textout_07: pre_identical=True win=4931 linux=4801 both=4798 win_only=133 linux_only=3
textout_10: pre_identical=True win=3509 linux=3418 both=3413 win_only=96 linux_only=5
textout_11: pre_identical=True win=3848 linux=3732 both=3697 win_only=151 linux_only=35
textout_12: pre_identical=False win=2144 linux=2076 both=2020 win_only=124 linux_only=56
```

`dib_cmp_textout_NN.png` は上から Windows・Wine・差(赤 = Windows だけ、青 = Wine だけ、灰 = 両方)、3 倍拡大。

**答え**: Windows でも二値(`0xf000 → 0x0` だけ)。GDI の AA の階調は Windows でも DIB に残らない。違いは「どの画素を書いたか」だけで、Windows は Wine より 2.1〜3.9% 多く画素を書く。差は主に字の縁(縦画の片側 1px など)。AA のカバー率が小さい縁の画素を、Windows は書き、Wine(FreeType)は書かない、またはグリフの輪郭のヒンティングが違う、のどちらかと考えられる(切り分けはしていない)。描画前の DIB は 5/6 件で Windows と Linux が完全に一致したので、違いは GDI の描画結果だけにある。このため (B) で転送元が一致しなかった。

## (B) d3dx9 の縮小結果

```powershell
(Get-Item C:\Windows\SysWOW64\d3dx9_43.dll).VersionInfo | Format-List FileVersion,ProductVersion
# FileVersion : 9.29.952.3111 / ProductVersion : 9.29.952.3111
Get-FileHash C:\Windows\SysWOW64\d3dx9_43.dll
# SHA256 0B28546BE22C71834501F7D7185EDE5D79742457331C7EE09EFC14490DD64F5F
```

(B-1) `D3DX_LOAD_PROBE=1`、`D3DX_DUMP_DIR=C:\th13-101\xfer_win_native` → `xfer_win_native\`(38 ファイル、拡大縮小を伴う転送 19 件)
(B-2) さらに `D3DX_AREA_FILTER=1` → `xfer_win_tent\`(ログに `area-filtered 1024x44 -> 512x20 (A4R4G4B4, filter=0x4, radius=0.80) hr=0`)

### 依頼どおりの比較

```
> compare_xfer_dumps.py OUT\xfer_win_native runs\101_linux_dumps\xfer_native
A: 8 transfers, B: 6 transfers, same source: 1
d3dx_01_dst.bin vs d3dx_01_dst.bin: 1024x44 -> 512x20 alpha levels A=1 B=1 mean|diff|=0.00 max=0 exact=1.000 within1step(17)=1.000

> compare_xfer_dumps.py OUT\xfer_win_native OUT\xfer_win_tent --png OUT\cmp_native_tent
A: 8 transfers, B: 8 transfers, same source: 8
d3dx_01_dst.bin vs d3dx_01_dst.bin: 1024x44 -> 512x20 alpha levels A=1 B=1 mean|diff|=0.00 max=0 exact=1.000 within1step(17)=1.000
d3dx_05_dst.bin vs d3dx_05_dst.bin: 1024x44 -> 512x20 alpha levels A=16 B=16 mean|diff|=0.39 max=17 exact=0.977 within1step(17)=1.000
d3dx_06_dst.bin vs d3dx_06_dst.bin: 1024x44 -> 512x20 alpha levels A=16 B=16 mean|diff|=0.25 max=17 exact=0.985 within1step(17)=1.000
d3dx_11_dst.bin vs d3dx_11_dst.bin: 1024x44 -> 512x20 alpha levels A=16 B=16 mean|diff|=0.31 max=17 exact=0.982 within1step(17)=1.000
d3dx_16_dst.bin vs d3dx_16_dst.bin: 1024x44 -> 512x20 alpha levels A=16 B=16 mean|diff|=0.27 max=17 exact=0.984 within1step(17)=1.000
d3dx_17_dst.bin vs d3dx_17_dst.bin: 662x36 -> 320x17 alpha levels A=16 B=16 mean|diff|=0.56 max=17 exact=0.967 within1step(17)=1.000
d3dx_18_dst.bin vs d3dx_18_dst.bin: 662x36 -> 320x17 alpha levels A=16 B=16 mean|diff|=0.65 max=17 exact=0.962 within1step(17)=1.000
d3dx_19_dst.bin vs d3dx_19_dst.bin: 662x36 -> 320x17 alpha levels A=16 B=16 mean|diff|=0.47 max=17 exact=0.972 within1step(17)=1.000

> compare_xfer_dumps.py OUT\xfer_win_native runs\101_linux_dumps\xfer_tent
A: 8 transfers, B: 6 transfers, same source: 1
d3dx_01_dst.bin vs d3dx_01_dst.bin: ... exact=1.000   (空の転送のみ)

> compare_xfer_dumps.py OUT\xfer_win_native runs\101_linux_dumps\xfer_area
A: 8 transfers, B: 6 transfers, same source: 1
d3dx_01_dst.bin vs d3dx_01_dst.bin: ... exact=1.000   (空の転送のみ)
```

`same source: 1` は空の転送(全面透明)だけ。(A) のとおり GDI の字形が Windows と Wine で違うため、文字のある転送は転送元が一致しない。

### 追加: Windows の d3dx9 をオフラインで呼んで直接比べる

転送元が揃わないままでは「同じ入力に対して同じ出力か」が言えないので、Windows の `d3dx9_43.dll` の `D3DXLoadSurfaceFromMemory` を直接呼ぶ小さなプログラムを作った(`offline_d3dx\d3dx_offline.cpp`、VS 2026 の `cl` で 32bit ビルド)。ダンプの転送元を読み、512x512 A4R4G4B4(D3DPOOL_SYSTEMMEM、0 で初期化)の面の、ゲームと同じ矩形((0,1)-(512,21) または (0,92)-(320,109))へ `D3DX_FILTER_TRIANGLE` で転送し、その矩形を同じ形式で書き出す。`offline_d3dx\run_offline.py` がダンプのフォルダ全体に適用する。

```bat
cl /O2 /EHsc d3dx_offline.cpp d3d9.lib user32.lib     (vcvars32.bat の環境で)
python runs\101_windows\offline_d3dx\run_offline.py d3dx_offline.exe C:\Windows\SysWOW64\d3dx9_43.dll <in_dir> <out_dir> 4 <fpu_preserve>
python runs\101_windows\offline_d3dx\count_diff.py <dirA> <dirB>     (転送先のアルファが違う画素の数と位置)
```

1 回目(デバイスを `D3DCREATE_FPU_PRESERVE` なしで作成)は、Windows のゲーム内の出力と比べて 1 転送あたり 3〜10 画素だけ違った。違う画素はすべて行 4 で、値は 4bit アルファの 7 と 8(= ちょうど 7.5 の丸め)。`FPU_PRESERVE` なしでは D3D9 が x87 を単精度にするため、丸めの境目で結果が変わる。`FPU_PRESERVE` 付きで作り直すと**完全に一致**した(ゲームは倍精度のまま d3dx9 を呼んでいることになる)。

```
### FPU_PRESERVE: オフライン(Windows の転送元) vs ゲーム内の Windows ネイティブ  → ハーネスの検証
d3dx_01 diff px 0 / 10240,  d3dx_05 0,  d3dx_06 0,  d3dx_11 0,  d3dx_16 0,  d3dx_17 0 / 5440,  d3dx_18 0,  d3dx_19 0
### FPU_PRESERVE: オフライン(Linux の転送元) vs Linux の Wine + ネイティブ DLL
d3dx_01 diff px 0 / 10240,  d3dx_05 0,  d3dx_06 0,  d3dx_11 0,  d3dx_16 0,  d3dx_17 0 / 5440
```

(`FPU_PRESERVE` なしでは Linux 側とも 2〜8 画素、同じ 7.5 の丸めの画素だけが違った。)

Linux の転送元をこのプログラムで縮小した結果と、Linux のテント縮小(`runs\101_linux_dumps\xfer_tent`)との比較:

```
d3dx_05: exact=0.977  d3dx_06: 0.983  d3dx_11: 0.981  d3dx_16: 0.984  d3dx_17(662x36->320x17): 0.971   いずれも within1step=1.000
```

(Linux で測った 0.971〜0.984 と同じ。)

**答え**:
- Windows 実機の `d3dx9_43.dll`(9.29.952.3111)の TRIANGLE 縮小は、Linux の Wine + ネイティブ DLL と**同じ入力なら画素単位で同じ**。ゲーム内のダンプ同士で一致しないのは、GDI の字形の違い(A)で転送元が違うため。
- テント縮小(半径 0.8)とネイティブの一致率は Windows 上のゲーム内比較で 0.962〜0.985、全画素 1 段階以内。Linux の値(0.971〜0.984)とほぼ同じ。662x36 → 320x17(スペルカード名)の縮小は 0.962〜0.972 と、1024x44 → 512x20 より少し低い。
- ネイティブとテントの差の一部は丸めの境目(ちょうど x.5)の扱いで、ゲームは倍精度で計算した結果を使っている。

### テントの半径の探索(B-2 を半径を変えて繰り返し)

`set D3DX_AREA_FILTER_RADIUS=<r>` を加えて (B-2) を 4 回(`xfer_win_tent_r<r>\`)。いずれも転送元は 8 件すべてネイティブと一致した。`compare_xfer_dumps.py OUT\xfer_win_native OUT\xfer_win_tent_r<r>` の完全一致率(空の転送を除く):

| 半径 | 1024x44→512x20(4 件) | 662x36→320x17(3 件) | 最大差 |
|---|---|---|---|
| 0.70 | 0.947〜0.962 | 0.915〜0.923 | 2 段階 |
| 0.75 | 0.969〜0.979 | 0.954〜0.956 | 1 段階 |
| **0.80(既定)** | **0.977〜0.985** | **0.962〜0.972** | 1 段階 |
| 0.85 | 0.957〜0.971 | 0.942〜0.950 | 1 段階 |
| 0.90 | 0.938〜0.957 | 0.912〜0.920 | 2 段階 |

両方の縮小率で **0.8 が最大**。Linux の Python 総当たり(0.80 が最良)と同じ結論で、既定値を変える理由は無い。半径 0.8 でも 662x36→320x17(縮小率 2.07/2.12)の一致率は 1024x44→512x20 より 1 ポイントほど低い。

## (C) 小さい MS ゴシックの GDI 描画

```bat
cd /d C:\th13-101
gdi_text_test.exe w400_q4.pgm "ＭＳ ゴシック" 4 400
gdi_text_test.exe w700_q4.pgm "ＭＳ ゴシック" 4 700
gdi_text_test.exe w400_q0.pgm "ＭＳ ゴシック" 0 400
gdi_text_test.exe w400_q5.pgm "ＭＳ ゴシック" 5 400
```

`python scripts\101_font_aa\analyze_gdi_pgm.py ...`(Windows):

```
w400_q4.pgm
  height:  12  13  14  15  16  17  18  19  20  21  22  23  24  25  26  27  28  29  30  31  32
  levels:   2   2   2   2   2   2   2   2   2  16  16  16  16  16  16  16  16  16  16  16  16
w700_q4.pgm
  height:  12  13  14  15  16  17  18  19  20  21  22  23  24  25  26  27  28  29  30  31  32
  levels:   2   2   2   2   2   2   2   2   2  16  16  16  16  16  16  16  16  16  16  16  16
w400_q0.pgm
  height:  12  13  14  15  16  17  18  19  20  21  22  23  24  25  26  27  28  29  30  31  32
  levels:   2   2   2   2   2   2   2   2   2   2   2   7   7   7   7   7   7   7   7   7   7
w400_q5.pgm
  height:  12  13  14  15  16  17  18  19  20  21  22  23  24  25  26  27  28  29  30  31  32
  levels:   2   2   2   2   2   2   2   2   2   2   2   7   7   7   7   7   7   7   7   7   7
```

Linux(`runs\101_linux_dumps\gdi`):

```
w400_q4.pgm  levels: 12〜20 が 2、21〜32 が 16
w700_q4.pgm  levels: 12〜32 すべて 16
```

画像: `gdi\w*.png`(PGM をそのまま PNG にしたもの)、`gdi\sidebyside_w400_q4.png`・`gdi\sidebyside_w700_q4.png`(height 12〜24、左 Windows・右 Wine、2 倍拡大)。変換は `gdi\pgm_to_png.py`。

**答え**:
- **weight 400・`ANTIALIASED_QUALITY`**: Windows も height 12〜20 が二値、21 以上が 16 階調で、**Wine と同じ**。Windows も gasp(9〜20ppem は DOGRAY なし)に従う。目視でも 12〜20 は埋め込みビットマップの字形で、Windows と Wine でほぼ同じ見た目。
- **weight 700(疑似ボールド)**: **違う**。Windows は 12〜20 も二値で、埋め込みビットマップを太らせた太字で描く。Wine は `AntialiasFakeBoldOrItalic` により全サイズ AA(16 階調)で、しかも height 12〜20 では**太字にならず、weight 400 とほぼ同じ細さ**に見える(side-by-side 画像)。th13 は `ＭＳ ゴシック height=15 weight=700` を作って使っている(Linux の記録で `TextOutA` 5 回)ので、この文字列は Windows では二値の太字、Wine では AA の細字になっているはず。録画で目立つかは未確認。
- **`q0`(DEFAULT_QUALITY)・`q5`(CLEARTYPE_QUALITY)**: この PC は ClearType が有効で、どちらも ClearType で描かれた。height 12〜22 は二値、23 以上は G チャンネルだけで 7 階調(テストプログラムは G チャンネルだけを PGM に書くので、ClearType の色付きの縁は捉えていない)。ClearType の二値の範囲が 22 まで延びるのは、gasp の 9〜20ppem に SYMMETRIC_SMOOTHING(0x8)が無いことと関係すると見られる(height と ppem の対応は未確認)。

## そこから言えること

1. Linux 側の結論(ジャギーの原因は d3dx9 の TRIANGLE 縮小の未実装で、GDI の AA は DIB に残らない)は、Windows 実機でも裏付けられた。Windows の GDI も DIB を二値にしか書かない。
2. Wine + ネイティブ `d3dx9_43.dll`(案B)は、同じ入力に対して Windows 実機と画素単位で同じ出力になる。
3. Windows 実機の画面と Wine + 案B/案A の画面に残る差は、主に GDI の字形の違い(Windows は 2〜4% 多くの画素を書き、文字がわずかに太い)による。縮小方式では詰められない。
4. テント縮小(半径 0.8)は Windows のネイティブ出力とも 96〜98.5% 一致し、全画素 1 段階以内。
5. 疑似ボールドの小さい MS ゴシック(th13 の height=15 weight=700 など)は、Wine では AA の細字、Windows では二値の太字になる。d3dx9 とは別の差で、フォントの見た目を Windows に近づけるなら、Wine の `AntialiasFakeBoldOrItalic` を無効にする(レジストリ `HKCU\Software\Wine\Fonts` の `AntialiasFakeBoldOrItalic="n"`)ことが候補になる(未検証)。

## ファイル一覧(`runs/101_windows/`)

| パス | 内容 |
|---|---|
| `dib/` | (A) の DIB ダンプとログ |
| `dib_cmp_textout_NN.png`、`dib_win_vs_linux.py` | (A) Windows と Wine の字形の画素比較 |
| `xfer_win_native/`、`xfer_win_tent/` | (B-1)(B-2) の転送ダンプとログ |
| `xfer_win_tent_r0.7/` など | テントの半径を変えた (B-2) |
| `cmp_native_tent_NN.png` | `compare_xfer_dumps.py --png` の出力(上から転送元・ネイティブ・テント・差×4) |
| `offline_d3dx/` | Windows の d3dx9 を直接呼ぶプログラム(`d3dx_offline.cpp`)、一括実行(`run_offline.py`)、画素差の数え上げ(`count_diff.py`)、出力(`win_src*`・`linux_src*`) |
| `gdi/` | (C) の PGM・PNG・side-by-side・`pgm_to_png.py` |

## 後片付け

- 作業中の `%APPDATA%\ShanghaiAlice\th13\`(作業中にゲームが作った `scoreth13.dat` を含む)を削除し、退避していた `th13.bak-101-windows` を `th13` に戻した。戻した後のファイル数は 45(退避前と同じ構成。`scoreth13.dat` 21,992 bytes・`replay.001\` などが元どおり、`th13_ud0000.rpy` は無い)。
- `th13.exe`・`injector.exe` のプロセスが残っていないことを確認した。
- リポジトリへの書き込みは `runs\101_windows\` だけ。git の操作はしていない。
- ローカルの `C:\th13-101\`(ゲーム一式のコピー、ダンプ、オフライン用プログラムのビルド)は再実験用に残してある。不要なら削除してよい。
