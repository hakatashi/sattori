---
name: build-mods
description: 東方タイトルの録画用 MOD（`thNN_hook.dll`）を mingw-w64 でクロスビルドする手順（th06c・th09・th10・th11・th12・th20）。「hook DLL をビルドして」「MOD をビルドし直して」等で使う。th20 は `-static` が必須、th06c は64bitクロスビルドとSteamworks APIスタブが必要など、知らないと DLL 注入が失敗する注意点があるため必ずこの手順に従うこと。
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

## 一括ビルド

全タイトル分の hook DLL、injector、Steamworks API スタブを一括ビルドする:

```bash
make -C worker/mods -j$(nproc) all
```

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
（`-static`必須。付けないとwine実行時にlibgcc_s/libstdc++が見つからずDLL注入が
失敗する、th20と同じ理由。`worker/docs/titles/th06c.md`参照）。入力はDirectInputでは
なくGetProcAddressフック方式のため、`dinput_hook.cpp`・`window_wait.cpp`は使わない
（起動ダイアログの除外ロジックがth06c専用に`dllmain.cpp`内へ実装済み）。

```bash
# th06c_hook.dll
make -C worker/mods th06c

# Steamworks APIスタブ(steam_api64.dll)。Steamクライアント常駐無しで起動させるための
# 必須コンポーネント(worker/docs/titles/th06c.md)。games/th06c/直下へ正規のsteam_api64.dll
# の代わりに同梱する(upload-title-assets skill)。
make -C worker/mods steam_api64
```

### th09

th09はth06/07/08/10/12と同じPressKey（DIK経由）を使う。低速録画フック（D3D8版
Present間引き・DirectSound周波数スケーリング・fps表示補正）を実装済みだが
`SLOW_MOTION_SUPPORTED_GAME_IDS`未登録のためユーザーには未公開（`worker/docs/titles/th09.md`）。
`dllmain.cpp`がこれらのフックを呼ぶため、ビルド時は`fps_limiter_hook_d3d8.cpp`・
`dsound_hook.cpp`・`fps_display_hook.cpp`を含める必要がある（th20と異なり`-static`は不要）。

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

**`-static` が必須**。付けないと wine 実行時に `libgcc_s_dw2-1.dll` /
`libstdc++-6.dll` が見つからず **DLL 注入が失敗する**（th20 固有で判明、
touhou-recorder reports/44）。

```bash
make -C worker/mods th20
```

### th06 / th07 / th08

`fps_monitor.cpp` を含めるかどうかだけが違う。th06/th07 は含めず、th08 は含める
（fps 暴走検知用、touhou-recorder reports/22）。`score_monitor.cpp`（リプレイずれ
判定用のスコア監視、Issue #103）は3タイトルとも共通で含める。

```bash
make -C worker/mods th06
make -C worker/mods th07
make -C worker/mods th08
```

## 関連

- ビルドした DLL の配布 → `upload-title-assets` skill
- MOD の設計・各フックの役割 → `worker/docs/mods.md`、`worker/docs/titles/thNN.md`
- ビルド定義 → `worker/mods/Makefile`
