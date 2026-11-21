# フェーズ39: th11ジャギー問題の追加調査(Wine内部実装の解析と対策の検証)

日付: 2026-07-26

## 目的

フェーズ38で「未解決」として残った、th11の文字輪郭がWindows実機よりジャギーな問題について、インターネット上の情報収集とWineのソースコード解析を行い、有望と思われた対策を実際に検証した。結論から言うと、**有効な対策は見つからなかった**が、フェーズ38時点では推測にとどまっていた原因を、Wineのソースコード解析と実機ログ・画素値比較によってより厳密に切り分けることができた。

## 前提: 再現手順の確立

ユーザーの指摘で、th11起動後のメインメニューで「Music Room」(Down x4 -> Enter)を選ぶとジャギーな文字(スペルカード名・NPCセリフ相当のUIテキスト)を素早く確認できることが分かった。当初xdotoolによる外部キー入力でメニュー操作を行ったが、`reports/06_replay_automation_mod_feasibility.md`で明記されている通りxdotoolの外部キー入力シミュレーションは信頼性が低い(本フェーズでも実際にmisclick的な挙動が発生した)ため、`mods/th11_replay_autoplay/`と同じ`GetKeyboardState`フック経由で内部からDown x4 -> Enterを実行する使い捨てプローブMOD(非コミット、`/tmp`配下でmingw-w64クロスビルド)を作成し、以降の検証はすべてこの内部操作方式で行った。

ユーザー提供のWindows実機スクリーンショット(`assets/screenshots/th11_music_room.png`)を全フェーズを通じての比較基準とした。

## 1. Web調査で見つかった一般的な対策とその位置づけ

- `winetricks settings fontsmooth=rgb/disable`、`HKCU\Control Panel\Desktop\FontSmoothing*`のレジストリ調整 → フェーズ38で既に試行済み・効果薄と判明済み
- `Xft.antialias`等のX11/fontconfigレベルの設定、`~/.config/fontconfig/fonts.conf`での`embeddedbitmap=false`指定 → 後述のソース解析の結果、Wineの当該テキスト描画経路(オフスクリーンDIBへのGDI描画)はXft/X11のフォントレンダリングを経由せず、Wine内蔵のFreeTypeベースのラスタライザを直接使うため、原理的に無関係と判断した
- Wine-staging の d3dx9 `ID3DXFont` 関連パッチ → th11はGDIの`CreateFontA`を直接呼んでおり(下記参照)、d3dx9のID3DXFont実装バグとは無関係と判明

上記はいずれも「日本語Windows作品をWineで動かす」という一般的な文脈での定番対策だが、本件(数値上はAAが機能しているのに実機より粗く見える)には効かないことをこのフェーズで確認した。

## 2. Wine (win32u) ソースコード解析

`dlls/win32u/font.c`の`font_SelectFont()`と`dlls/win32u/freetype.c`の`freetype_get_aa_flags()`を実際にダウンロードして読み、lfQualityからAAフラグが決定される仕組みを特定した。

- `lfQuality`が`NONANTIALIASED_QUALITY`/`ANTIALIASED_QUALITY`の場合は無条件にそれぞれ`GGO_BITMAP`/`GGO_GRAY4_BITMAP`が確定する。`DEFAULT_QUALITY`の場合のみ、フォント単位のfontconfig由来値→`HKCU\Control Panel\Desktop\FontSmoothing`系レジストリの順にフォールバックする
- `freetype_get_aa_flags()`は、AAフラグが`GGO_GRAY*_BITMAP`系または`WINE_GGO_*RGB/BGR_BITMAP`(ClearType的なサブピクセル系)の場合にのみ、フォントの`gasp`テーブルを参照し、該当ピクセルサイズで`GASP_DOGRAY`ビットが立っていなければ強制的に`GGO_BITMAP`(非AA)へ格下げする。ただしサブピクセル系フラグで`is_subpixel_rendering_enabled()`が真の場合はこのgaspチェックより前の`break`で経路を抜けるため、gaspの影響を受けない
- `is_hinting_enabled()`はFreeTypeライブラリのビルド設定(特許型TrueTypeエンジンが有効か)のみで決まり、実行時設定では変更できない

## 3. 診断用MOD: `mods/common/font_quality_hook.h/.cpp`

上記の切り分けのため、`gdi32.dll`の`CreateFontA/W`・`CreateFontIndirectA/W`・`CreateFontIndirectExA/W`をIATフックし、(1)実際に要求された`lfQuality`をログに記録、(2)`lfQuality`を任意の値に強制書き換えできる診断用MODを実装した(`mods/common/dinput_hook.cpp`と同じIATフック手法を流用)。th11に注入したところ、以下が判明した:

```
CreateFontA: face='ＭＳ ゴシック' height=32 weight=400 quality=4
CreateFontA: face='ＭＳ 明朝'     height=32 weight=600 quality=4
CreateFontA: face='ＭＳ ゴシック' height=15 weight=700 quality=4
CreateFontA: face='ＭＳ 明朝'     height=15 weight=700 quality=4
```

**th11は`DEFAULT_QUALITY`ではなく、既に明示的に`ANTIALIASED_QUALITY`(=4)でフォントを生成していた。** フェーズ38時点では「ゲームがどのlfQualityを使っているか不明」という前提で調査していたが、これは誤りだったと判明した。またフックできたのは`CreateFontA`のみ(6種のうち1/6)で、th11はCreateFontIndirect系ではなく`CreateFontA`(パラメータ渡し版)を直接呼んでいることも分かった。

## 4. 対策候補の検証(いずれも実機との差を解消できず)

### 4.1 `CLEARTYPE_QUALITY`への強制書き換え

`freetype_get_aa_flags()`のgaspチェックはサブピクセル系フラグでは`is_subpixel_rendering_enabled()`が真ならバイパスされる、という解析結果に基づき、上記フックで`lfQuality`を`CLEARTYPE_QUALITY`(5)に強制した。結果、Music Room画面のテキストに明確な色収差(赤/青の縁取り)が出現し、Wineのサブピクセルレンダリング経路(`WINE_GGO_HRGB_BITMAP`)が実際に有効化されたことを視覚的に確認できた。

しかし、同一スキャンライン上の画素値をquality=4(既定)と比較したところ、グレースケール階調の遷移幅・階調数はほぼ変わらなかった(下記4.3のスキャンライン比較データ参照)。色収差が出る分むしろ録画品質としては悪化する懸念があり、**有効な対策ではないと判断した**。

### 4.2 MS Gothicのgaspテーブル書き換え

`fontTools`でmsgothic.ttcのgaspテーブルを調べたところ、次の値を確認した:

| フォント | gaspRange (maxPPEM: flags) |
|---|---|
| MS Gothic / MS UI Gothic / MS PGothic | `{9: 9, 20: 5, 65535: 11}` |
| MS Mincho / MS PMincho | `{7: 10, 20: 7, 65535: 11}` |

MS Gothicは20ppem以下の範囲(flags=5=`GASP_GRIDFIT+GASP_SYMMETRIC_GRIDFIT`)で`GASP_DOGRAY`ビットが立っておらず、理論上は「15px相当のテキストでWineがgaspに従って非AA(`GGO_BITMAP`)に格下げする」可能性がある(MS Minchoは全レンジで`GASP_DOGRAY`が立っており該当しない)。この仮説を検証すべく、`fontTools`で全レンジに`GASP_DOGRAY`ビットを強制追加したmsgothic.ttcを生成し、`prefixes/th11-wined3d-gl`に配置(`wineserver -k`で再起動)して再検証した。

**結果: 画素値レベルで書き換え前後の出力は(背景パーティクルの位置ズレを除き)完全に一致した。** gaspパッチは何の効果もなかった。

`WINEDEBUG=+font`でWine自身のトレースログを取得したところ、th11実行中を通じて`aa disabled by GASP`のトレース行は**1回も出現しなかった**。また実際に`font_SelectFont`が呼ばれたMS Gothicのインスタンスは`height=32`の1件のみで(`height=15`のフォントは`CreateFontA`で生成はされるが、少なくともこの画面では`SelectObject`されてGDI描画に使われた形跡がなかった)、この`height=32`はgaspの`{65535: 11}`(`GASP_DOGRAY`あり)の範囲に該当するため、そもそもgasp格下げの対象外だった。**フェーズ38で観測された「タイトル画面のテーマです。」等のUIテキストは、想定していた15px相当ではなく32px指定のMS Gothicで描画されており、gasp仮説はこのテキストには当てはまらなかった。**

### 4.3 実機との厳密なスキャンライン比較

`ImageDraw`等を使わず、実機・修正前・CLEARTYPE強制後の3枚から同一座標(「イ」の縦画、y=365, x=95〜110)の輝度値を直接比較した:

```
実機(参照):        [24, 18, 48, 169, 194, 131, 68, 38, 105, 211, 118, 18, 9, 8, 7]
Wine (quality=4):  [52, 41, 0, 0, 221, 255, 255, 170, 0, 255, 170, 0, 15, 13, 12]
Wine (CLEARTYPE):  [30, 0, 0, 0, 166, 255, 255, 100, 0, 255, 108, 0, 9, 8, 7]
```

実機は8〜10px程度にわたってなだらかに輝度が遷移するのに対し、Wine側はquality=4・CLEARTYPE強制のいずれも3〜4pxで急峻に遷移する(`GGO_GRAY4_BITMAP`の4bit=17階調という量子化幅の粗さが影響していると推測される)。**この量子化の粗さ・遷移幅の狭さは、lfQualityの書き換えでは変化しなかった。**

また「本当にWindows実機のスクリーンショット自体が何らかのスケーリング等でぼけているだけではないか」という別解釈を排除するため、テキストを含まない背景装飾(雪の結晶パーティクル)領域を実機・Wineで比較したところ、両者とも同程度のブロック感(ジャギー)を持つドット柄で、実機側が特別にぼけているわけではないことを確認した。**つまり今回の差はテキスト描画パス固有のものであり、画面全体のスケーリング起因ではない。**

## 5. MacType(旧gdi++)の適用検証

ユーザーからの提案で、Windows向けのGDIフックによるフォント描画差し替えツール「MacType」(gdi++の後継、https://github.com/snowie2000/mactype)がWine上のth11に適用できないか検証した。MacTypeは`gdi32.dll`のテキスト描画APIをフックし、独自にバンドルしたFreeTypeで再描画する仕組みで、原理上は本件(Wine内蔵のFreeTypeベースAAの粗さ)を回避できる可能性があった。

### 5.1 ポータブル版(zip配布、`MacLoader.exe <target.exe>`)

インストーラーなしのzip版(`mactype-20230531.zip`)からファイル一式をth11の実行フォルダにコピーし、`MacLoader.exe th11.exe`で起動した。`MacLoader.exe`はDetoursの`DetourCreateProcessWithDllEx`でプロセス起動時にDLLを注入する方式で、Wine上でも起動自体は成功した(usage文言のダイアログも正しく描画されており、Wine上でのGUI表示自体は問題なかった)。

ナビゲーション(Down x4 -> Enter でMusic Room選択)は、`MacLoader.exe`自身がプロセスを起動する都合上`mods/common/injector.cpp`のCREATE_SUSPENDED方式を併用できなかったため、起動済みプロセスへ後から注入する調査用ツール(`live_injector.exe`、非コミット)を別途作成し、`mods/th11_replay_autoplay`と同じ`GetKeyboardState`フック方式のプローブMODを起動後に追加注入する形で実施した。

結果、Music Room画面のスクリーンショットを撮ったところ、**MacTypeあり/なしで文字の見た目・画素値ともに完全に一致した**(グリフを構成する画素値が背景ノイズを除いて1桁も違わず同一)。プロセスの`/proc/<pid>/maps`を確認したところ、注入用ヘルパーの`EasyHK32.dll`は読み込まれていたが、**実際に描画を差し替える`MacType.dll`本体はロードされていなかった**。ポータブルzip版はインストーラーが本来HKLM配下に書き込む設定を欠いており、その判定で読み込みが弾かれていたと推測した。

### 5.2 インストーラー版

上記の推測を検証すべく、本番の`prefixes/th11-wined3d-gl`を汚さないよう複製した検証専用WINEPREFIX(`prefixes/th11-wined3d-gl-mactype-test`、検証後削除済み)に、最新リリース(`MacTypeInstaller_2025.6.9.exe`、Inno Setup製)を`/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /NOICONS`でサイレントインストールした。レジストリを確認したところ、MacType自体の設定はレジストリではなく`MacType.ini`で完結しており(アンインストール情報のみレジストリに登録される)、5.1の「レジストリ設定欠如」という推測は誤りだったと判明した。

インストール先(`C:\Program Files\MacType\`)の`MacLoader.exe`から改めてth11.exeを起動したところ、今度は明確なエラーで**プロセスの起動自体が失敗した**:

```
err:module:loader_init "MacType.dll" failed to initialize, aborting
err:module:loader_init Initializing dlls for L"...th11.exe" failed, status c0000142
```

`STATUS_DLL_INIT_FAILED`(`c0000142`)は、`MacType.dll`の`DllMain`(`DLL_PROCESS_ATTACH`)がWine上で正常終了しなかったことを示す。ポータブル版と異なり、インストーラー版は`DetourCreateProcessWithDllEx`によって注入対象DLLがプロセスの静的インポートとして早期ロードされる経路を通ったためこの失敗が致命的となり(ポータブル版では同じ理由で恐らく同様に失敗していたが、失敗を無視して起動を継続する経路だったため気づかなかったと考えられる)、プロセスが一切起動しなかった。

これは**MacType.dll自体がWine上でのDLL初期化に失敗する**という、より踏み込んだ根本的な非互換性を示しており、単なる設定不足ではなくツール自体がこの環境で動作しないと判断できる。

### 5.3 結論(MacType)

MacTypeはWine上のth11では**ポータブル版・インストーラー版のいずれも実際の描画差し替えに至らなかった**(ポータブル版は無言でMacType.dll本体がロードされず無効化、インストーラー版はDllMain初期化失敗でプロセス起動自体が失敗)。この種のGDIフック型フォント描画ツールは、Wineの`gdi32.dll`実装(実体はWine独自の`win32u.dll`)やプロセス初期化順序が実機Windowsと異なることが原因で、根本的に動作しない可能性が高い。少なくとも今回試した範囲では有効な解決策にならなかった。

## 6. 結論

- gaspテーブル・lfQuality経由の対策はいずれも実効性がないことを画素値レベルで確認した(フェーズ38時点の推測に対する追加検証として、原因候補を2つ具体的に排除できた)
- th11は既に`ANTIALIASED_QUALITY`を明示指定しており、「アンチエイリアスがオフになっている」という単純な問題ではない。WineのFreeTypeベースのグレースケールAA(`GGO_GRAY4_BITMAP`, 4bit=17階調)自体が、実機Windowsの対応する描画結果と比べて遷移幅が狭く・階調が粗いという、**アルゴリズムそのものの違い**が実態に近いと考えられる
- MacType(旧gdi++)のようなGDIフック型フォント描画差し替えツールも、Wine上ではDLL初期化自体に失敗し適用できなかった
- この差はWineのGDI/FreeTypeラスタライザとWindows実機のGDIレンダラの実装差に起因する可能性が高く、本リポジトリの操作範囲(レジストリ・fontconfig・フォントファイル・lfQuality・サードパーティのGDIフックツール)では解消できないというフェーズ38の結論を、より強い証拠とともに再確認した形になる

## 変更ファイル

- `mods/common/font_quality_hook.h`, `mods/common/font_quality_hook.cpp`(新規): GDIフォント生成APIの診断用IATフック。対策としては効果がなかったが、「ゲームが実際にどのlfQualityでフォントを要求しているか」を確認する診断ツールとして残置する
- `prefixes/th11-wined3d-gl`(gitignore対象): 検証用に一時的にmsgothic.ttcのgaspテーブルを書き換えたが、効果がなかったため**オリジナルへ復元済み**(リポジトリ・本番環境への影響なし)

## 今後の課題

- 文字輪郭のジャギー(グレースケール階調の遷移幅の粗さ)は引き続き未解決。Wine自体のFreeTypeベースラスタライザの实装(あるいはリンクされているFreeTypeのバージョン・ビルドオプション)を変更しない限り解消は難しいと考えられ、費用対効果の観点から本リポジトリでは対応を見送る
- MacType(旧gdi++)はポータブル版・インストーラー版いずれもWine上で`MacType.dll`のDLL初期化自体に失敗し、適用できなかった(5節参照)。同種の他のGDIフックツール(古いgdi++本家等)も同様にWine非互換の可能性が高く、優先度を下げて良いと判断する
- 未検証の残りの可能性として、(1)実機Windows側でMS Gothicが何らかのフォントリンク機構によりMeiryo/Yu Gothic等の別フォントに置き換わっている可能性、(2)WindowsのGDIが`ANTIALIASED_QUALITY`要求時にDWMコンポジション経由でさらに平滑化を行っている可能性、が挙げられるが、いずれも実機側の検証(Windows実機でのAPI呼び出しトレース等)が必要でありこのリポジトリの範囲外
