# 0071. th10〜th13の文字のジャギーは、MOD側でD3DXの縮小フィルタを補って直す(既定で有効)

- **状態**: 有効
- **決定日**: 2026-11-12
- **対象**: worker(`worker/mods/`)
- **関連**: touhou-recorder reports/101・102、[`docs/reports/2026-11-12-d3dx-text-filter-verification.md`](../reports/2026-11-12-d3dx-text-filter-verification.md)

th10・th11・th12・th128・th13のMODは、`D3DXLoadSurfaceFromMemory`のIATフック
(`worker/mods/common/d3dx_filter_hook.*`)で、文字の縮小転送を自前のテント縮小に置き換える。
**既定で有効**で、ワーカー(Python)からは何も渡さない。外すと会話文・スペルカード名がジャギーに戻る。

## 背景

これらのタイトルは会話文・スペルカード名をGDIで2倍の大きさに描き(文字の形はアルファの0/Fだけ)、
`D3DXLoadSurfaceFromMemory`(`D3DX_FILTER_TRIANGLE`)で縮小してテクスチャへ転送する。Windowsの
d3dx9はフィルタどおり平均化するので縁が滑らかになるが、Wineの内蔵d3dx9はTRIANGLE等を実装しておらず
常に最近傍で間引くため、文字がジャギーになる(touhou-recorder reports/101)。th11の
`worker/docs/titles/th11.md`で「既知の制約(対応なし)」としていたジャギーは、FreeTypeのAAではなく
この縮小が原因だった。

## 決定

- touhou-recorderの`mods/common/d3dx_filter_hook.cpp`のうち、縮小部分(案A、`D3DX_AREA_FILTER=1`相当)
  だけを取り込んだ。縮小を伴いフィルタがLINEAR/TRIANGLE/BOXの呼び出しを、半径0.8×縮小率のテントで
  縮小し、転送先と同じサイズにして`D3DX_FILTER_NONE`で元の関数へ渡す。
- 診断用の機能(`D3DX_LOAD_PROBE`・`D3DX_DUMP_DIR`・`D3DX_TIMING`・`D3DXLoadSurfaceFromSurface`の記録)と
  半径の環境変数(`D3DX_AREA_FILTER_RADIUS`)は取り込まない。半径は0.8に固定。
- touhou-recorderでは`D3DX_AREA_FILTER=1`で有効化していたが、sattoriでは**既定で有効**にし、
  `D3DX_AREA_FILTER=0`のときだけフックしない(比較用)。
- 組み込むのはth10・th11・th12・th128・th13の5タイトル。

## 根拠

- 負荷: 改良版のテント縮小は文字の転送1回0.29msで、現行(Wineの最近傍)の0.32msと同等。
  AWS `c7i.2xlarge`でth11・th12(等倍)・th13(1/2倍速)をフィルタの有無で各2回録り、落ち率・FpsMonitor・
  理論尺・同期マーカーに有意差は無かった(touhou-recorder reports/101 §10、reports/102 §3)。
- 画質: ネイティブd3dx9_43のTRIANGLEの出力と4bitアルファで96〜98.5%一致し、全画素1段階以内
  (reports/101 §9)。5タイトルとも字形の崩れ・位置ずれは無く、スコアも一致(reports/102 §2)。
- 既定で有効にするのは、ワーカーの中にタイトルの分岐を作らないため(AGENTS.md §3)。フックが要るかどうかは
  タイトル固有の事情なので、そのタイトルのMODに閉じ込める。環境変数で有効化する方式だと、
  `GameConfig.build_env()`(全タイトル共通)か`record_thNN.py`に設定を足す必要がある。

## 採らなかった選択肢

| 案 | 理由 |
| --- | --- |
| 案B: ネイティブd3dx9(`WINEDLLOVERRIDES=d3dx9_43=n,b`) | 効果はある。ただしタイトルごとに`d3dx9_31`〜`_43`が要り、Microsoftの再頒布物をタイトル資産に入れる扱いの確認が要る。d3dx9全体が置き換わるので文字以外への影響も確かめる必要がある。会話開始時の転送が1回あたり4倍重く、1フレームに集中する(reports/101 §10.3) |
| 案C: Wine本体にTRIANGLEを実装 | 自前ビルドのWineを本番イメージに入れる負担が大きい。案Aで同じ結果になる |
| gaspの書き換え・`lfQuality`の書き換え・テクスチャのサンプラーをLINEARにする | いずれも効果なし(reports/101 §2.3、旧reports/39) |
| th15にも組み込む | 内部解像度1280x960では文字を等倍で転送しており(`filter=NONE`)、縮小転送が1回も無い(reports/102 §1)。組み込んでも画面は変わらない |

## 影響範囲

- `worker/mods/common/d3dx_filter_hook.*`、`worker/mods/Makefile`(`SRC_D3DX`)、
  th10・th11・th12・th128・th13の`dllmain.cpp`。
- MODを変えたらタイトル資産を再アップロードすること(`upload-title-assets` skill)。
- th15を640x480で動かすように変える場合は縮小転送が起きうる。その場合はth15にも組み込むことを検討する(未確認)。
