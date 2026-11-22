---
name: build-mods
description: 東方タイトルの録画用 MOD（`thNN_hook.dll`）を mingw-w64 でクロスビルドする手順（th06c・th06nc・th09・th10・th11・th12・th13・th14・th15・th20・th128）。「hook DLL をビルドして」「MOD をビルドし直して」等で使う。th06c/th06nc は64bitクロスビルドとSteamworks APIスタブが必要、th20/th15/th14/64bit は `-static` 付きなど、知らないと DLL 注入が失敗する注意点があるため必ずこの手順に従うこと。
---

# MOD（`*_hook.dll`）・injector.exe のビルド

`worker/mods/Makefile` によるクロスビルドが正式なビルド経路（実機注入テストで意図通りに
動作することを確認済み、touhou-recorder reports/25）。コンパイラとして `mingw-w64`
（`i686-w64-mingw32-g++` / `x86_64-w64-mingw32-g++`）を使用する。かつて存在した MSVC 経路
（`build.bat`、Windows + Visual Studio 前提）は、このマシンに Windows/MSVC 環境が無く
実際には使われないまま実装から乖離していたため廃止した（Issue #102）。

ビルド成果物（`mods/**/build/`）は gitignore 済みで、S3 のタイトル資産アーカイブに
同梱して配布する（`upload-title-assets` skill）。**MOD を再ビルドしたら、必ず
タイトル資産も再アップロードすること**。しないと本番は古い DLL のまま動く。

## ビルドの仕組み(Issue #392・#393)

- **タイトルが組み込むモジュールは`Makefile`の「タイトルの宣言」**（`thNN_ARCH`・`thNN_MODS`・
  `thNN_STATIC`・`thNN_LIBS`）で決まる。モジュールとソースの対応は同じ`Makefile`の`MOD_*`、各ソースの役割は
  `worker/docs/mods.md`。フックを足すときは`MOD_*`と宣言を書き換えるだけで、規則は書かない。
- オブジェクトはアーキテクチャごとに1回だけ`worker/mods/obj/{32,64}/`へコンパイルし、タイトル間で共有する
  （gitignore済み）。`-MMD -MP`で依存関係を自動生成するので、ヘッダを変えても該当オブジェクトが
  再ビルドされる。ソースは`-I.`で`"core/log.h"`のように`mods/`からのパスで include する。
- 共通フラグは`-std=c++20 -Wall -Wextra -Werror`（`-Wno-cast-function-type`のみ除外。GetProcAddressの
  FARPROCキャストは避けられないため）、リンクは`-s`（strip）。警告は残さず直すこと。
- Steamworks APIスタブは`tools/steam_stub.cpp`の1本から、`-DAPP_ID`・`-DLOG_NAME`だけ変えて
  th06c用・th06nc用の2つをビルドする。出力パスは`th06c_steam_stub/build/`・`th06nc_steam_stub/build/`のまま。

## 一括ビルド

全タイトル分の hook DLL、injector、Steamworks API スタブを一括ビルドする:

```bash
make -C worker/mods -j$(nproc) all
```

ビルドしたら検査も通す（CIの`mods-build-smoketest`と同じ。ホストの`g++`が要る）:

```bash
make -C worker/mods -j$(nproc) check   # check-compile・check-imports・test
```

- `check-imports`: 全DLL・EXEのインポートにMinGWのランタイム（`libgcc_s`・`libstdc++`・`libwinpthread`）が
  出ていないか。出ているとWineで注入に失敗する（th20、touhou-recorder reports/44）。
- `test`: Win32に依存しないロジックの単体テスト（`worker/mods/tests/test_*.cpp`）。ログの契約
  （`core/log_contract.h`）を変えたら`worker/tests/test_mod_log_contract.py`も通ること。
- `check-compile`: どのタイトルにも組み込んでいないソース（`present/dxgi.cpp`）のコンパイル。

ビルド成果物を削除してクリーンビルドする場合:

```bash
make -C worker/mods clean && make -C worker/mods -j$(nproc) all
```

---

## 各タイトルの個別ビルドと注意点

### injector.exe / injector64.exe（共通）

複数 DLL の順次注入に対応した共通インジェクタ（タイトル非依存。th06 の VsyncPatch と
MOD 本体の共存にも使う）。

```bash
# 32bit版 injector.exe
make -C worker/mods injector

# 64bit版 injector64.exe (th06c用)
make -C worker/mods injector64
```

### th06c

th06cは他タイトルと異なり **th06c.exeがPE32+(x86-64)** なので、injector・MOD・
Steamworks APIスタブのすべてを `x86_64-w64-mingw32-g++` でクロスビルドする
（`-static`付き。`worker/docs/titles/th06c.md`参照）。入力はDirectInputでは
なくGetProcAddressフック方式のため、`input/dinput.cpp`は使わない（th06ncと共通の部分は`autoplay/dxlib_common.cpp`・`input/dxlib_input.cpp`）
（起動ダイアログの除外ロジックがth06c専用に`dllmain.cpp`内へ実装済み）。

```bash
# th06c_hook.dll
make -C worker/mods th06c

# Steamworks APIスタブ(steam_api64.dll)。Steamクライアント常駐無しで起動させるための
# 必須コンポーネント(worker/docs/titles/th06c.md)。games/th06c/直下へ正規のsteam_api64.dll
# の代わりに同梱する(upload-title-assets skill)。
make -C worker/mods steam_api64
```

### th06nc

th06ncはth06cと同じDXライブラリ系エンジンの64bitバイナリで、ビルド方法もth06cと
ほぼ同一（`-static`必須、Steamworks APIスタブが要る）。通常はGPUインスタンス・別ECRイメージ
（worker-gpu）で録画し、CPU描画は1/2倍速でだけ使う（`worker/docs/titles/th06nc.md`、Issue #241）。
CPU描画用のBC7展開フック（`texture/d3d11_bc7.cpp`）を一緒にリンクするため、
**`-ldxguid`が要る**（Makefileに記述済み。無いと`IID_ID3D11Device`等が未解決になる）。
Steam AppIDがth06cと異なる（4763590、th06cは4771400）ため、Steamworks APIスタブは
`th06nc_steam_stub/`として別ビルドする（インターフェースの個別対応は不要だった
実機確認済みだが、`GetAppID()`が将来呼ばれた場合に備えAppIDだけ正しい値にしてある）。

```bash
# th06nc_hook.dll
make -C worker/mods th06nc

# Steamworks APIスタブ(th06nc用、AppIDのみth06c用と異なる)
make -C worker/mods steam_api64_th06nc
```

### th09

th09はth06/07/08/10/12と同じPressKey（DIK経由）を使う。倍速録画フック（D3D8版
Present間引き・DirectSound周波数スケーリング・fps表示補正、`worker/docs/titles/th09.md`）も
ここで組み込む。
`Makefile`の宣言では`present`（D3D8のアダプタを含む）・`fps_display`を組み込む（th20と異なり`-static`は不要）。

```bash
make -C worker/mods th09
```

### th10 / th11 / th12

th10/th12はth06/07/08と同じPressKey（DIK経由）を使うため、`InstallKeyboardStateHook`は
不要（`th11・th20と異なる`、詳細は`worker/docs/titles/th10.md`）。

```bash
make -C worker/mods th10
make -C worker/mods th11
make -C worker/mods th12
```

### th20

th20 はフック3つ（Present 制御・DirectSound 周波数・fps 表示補正）が追加で要る。

`-static` を付けてビルドする（th20 で判明した、wine 実行時に `libgcc_s_dw2-1.dll` /
`libstdc++-6.dll` が見つからず DLL 注入が失敗する問題への対策、touhou-recorder reports/44）。
ただし objdump で確認すると、32bit DLL のインポートは `-static` の有無にかかわらず
`KERNEL32`・`msvcrt`・`USER32` だけで、`-static` 無しの th10 等でも注入できている。全タイトルを
`-static` に揃えるかは、全タイトルの MOD 統合テストを伴う別の判断（Issue #392 では揃えていない）。

```bash
make -C worker/mods th20
```

### th06 / th07 / th08

th08 と th06 は fps 表示補正（`clock/fps_display.cpp`）を含め、th07 は含めない。
`score_monitor.cpp`（リプレイずれ判定用のスコア監視、Issue #103）は3タイトルとも共通で含める。

```bash
make -C worker/mods th06
make -C worker/mods th07
make -C worker/mods th08
```

### th128

th128はth10/th12と同じPressKey（DIK経由）を使う（`InstallKeyboardStateHook`は不要）。
倍速録画フック（Presentの間引き・DirectSound周波数スケーリング、`worker/docs/titles/th128.md`）を含む。
`Makefile`の宣言では`present`を組み込む（`dsound`は全32bitタイトル共通。th20と異なり`-static`は不要）。

```bash
make -C worker/mods th128
```

### th13

th13はth128と同じ構成（PressKey（DIK経由）・Presentの上限・DirectSound周波数、`-static`は不要）。
VsyncPatchは使わない（`worker/docs/titles/th13.md`）。

```bash
make -C worker/mods th13
```

### th14

th14はth15と同じ構成（PressKey（DIK経由）・Presentの上限・fps表示補正（ViaCaller）、`-static`必須）。
`worker/docs/titles/th14.md`。

```bash
make -C worker/mods th14
```

### th15

th15はth10/th12と同じPressKey（DIK経由）を使う（`InstallKeyboardStateHook`は不要。
「TH10以降のエンジンはGetKeyboardState」という経験則はth15には当てはまらない、
`worker/docs/titles/th15.md`）。フック構成はth20と同じ（Present制御・DirectSound
周波数・fps表示補正フック。`ViaCaller`方式で`dllmain.cpp`から組み込む）で、`-static`付きでビルドする
（th20と同じ理由）。

```bash
make -C worker/mods th15
```

## 関連

- ビルドした DLL の配布 → `upload-title-assets` skill
- MOD の設計・各フックの役割 → `worker/docs/mods.md`、`worker/docs/titles/thNN.md`
- ビルド定義 → `worker/mods/Makefile`
