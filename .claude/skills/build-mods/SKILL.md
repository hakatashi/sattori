---
name: build-mods
description: 東方タイトルの録画用 MOD（`thNN_hook.dll`）を mingw-w64 でクロスビルドする手順（th09・th10・th11・th12・th20）。「hook DLL をビルドして」「MOD をビルドし直して」等で使う。th20 は `-static` が必須など、知らないと DLL 注入が失敗する注意点があるため必ずこの手順に従うこと。
---

# MOD（`*_hook.dll`）・injector.exe のビルド

`i686-w64-mingw32-g++` によるクロスビルドが正式なビルド経路（実機注入テストで意図通りに
動作することを確認済み、touhou-recorder reports/25）。かつて存在した MSVC 経路
（`build.bat`、Windows + Visual Studio 前提）は、このマシンに Windows/MSVC 環境が無く
実際には使われないまま実装から乖離していたため廃止した（Issue #102）。

ビルド成果物（`mods/**/build/`）は gitignore 済みで、S3 のタイトル資産アーカイブに
同梱して配布する（`upload-title-assets` skill）。**MOD を再ビルドしたら、必ず
タイトル資産も再アップロードすること**。しないと本番は古い DLL のまま動く。

## injector.exe（共通）

複数 DLL の順次注入に対応した共通インジェクタ（タイトル非依存。th06 の VsyncPatch と
MOD 本体の共存にも使う）。ビルドは1回で全タイトル分を兼ねる。

```bash
cd worker/mods/common
mkdir -p build
i686-w64-mingw32-g++ -O2 -o build/injector.exe injector.cpp \
  -static-libgcc -static-libstdc++
```

## th09

th09はth06/07/08/10/12と同じPressKey（DIK経由）を使う。低速録画フック（D3D8版
Present間引き・DirectSound周波数スケーリング・fps表示補正）を実装済みだが
`SLOW_MOTION_SUPPORTED_GAME_IDS`未登録のためユーザーには未公開（`worker/docs/titles/th09.md`）。
`dllmain.cpp`がこれらのフックを呼ぶため、ビルド時は`fps_limiter_hook_d3d8.cpp`・
`dsound_hook.cpp`・`fps_display_hook.cpp`を含める必要がある（th20と異なり`-static`は不要）。

```bash
cd worker/mods/th09_replay_autoplay
mkdir -p build
i686-w64-mingw32-g++ -shared -O2 -o build/th09_hook.dll \
  dllmain.cpp ../common/dinput_hook.cpp ../common/window_wait.cpp \
  ../common/logging.cpp ../common/fps_monitor.cpp ../common/fps_limiter_hook_d3d8.cpp \
  ../common/dsound_hook.cpp ../common/fps_display_hook.cpp ../common/score_monitor.cpp \
  -luser32 -static-libgcc -static-libstdc++
```

## th10

th10はth06/07/08と同じPressKey（DIK経由）を使うため、`InstallKeyboardStateHook`は
不要（`th11・th20と異なる`、詳細は`worker/docs/titles/th10.md`）。

```bash
cd worker/mods/th10_replay_autoplay
mkdir -p build
i686-w64-mingw32-g++ -shared -O2 -o build/th10_hook.dll \
  dllmain.cpp ../common/dinput_hook.cpp ../common/window_wait.cpp \
  ../common/logging.cpp ../common/fps_monitor.cpp ../common/score_monitor.cpp \
  -luser32 -static-libgcc -static-libstdc++
```

## th11

```bash
cd worker/mods/th11_replay_autoplay
mkdir -p build
i686-w64-mingw32-g++ -shared -O2 -o build/th11_hook.dll \
  dllmain.cpp ../common/dinput_hook.cpp ../common/window_wait.cpp \
  ../common/logging.cpp ../common/fps_monitor.cpp ../common/score_monitor.cpp \
  -luser32 -static-libgcc -static-libstdc++
```

## th12

th12はth10と同じPressKey（DIK経由）を使う（`worker/docs/titles/th12.md`）。

```bash
cd worker/mods/th12_replay_autoplay
mkdir -p build
i686-w64-mingw32-g++ -shared -O2 -o build/th12_hook.dll \
  dllmain.cpp ../common/dinput_hook.cpp ../common/window_wait.cpp \
  ../common/logging.cpp ../common/fps_monitor.cpp ../common/score_monitor.cpp \
  -luser32 -static-libgcc -static-libstdc++
```

## th20

th20 はフック3つ（Present 制御・DirectSound 周波数・fps 表示補正）が追加で要る。

**`-static` が必須**。付けないと wine 実行時に `libgcc_s_dw2-1.dll` /
`libstdc++-6.dll` が見つからず **DLL 注入が失敗する**（th20 固有で判明、
touhou-recorder reports/44）。

```bash
cd worker/mods/th20_replay_autoplay
mkdir -p build
i686-w64-mingw32-g++ -shared -O2 -o build/th20_hook.dll \
  dllmain.cpp ../common/dinput_hook.cpp ../common/window_wait.cpp \
  ../common/logging.cpp ../common/fps_monitor.cpp ../common/fps_limiter_hook.cpp \
  ../common/dsound_hook.cpp ../common/fps_display_hook.cpp ../common/score_monitor.cpp \
  -luser32 -static-libgcc -static-libstdc++ -static
```

## th06 / th07 / th08（mingw-w64）

`fps_monitor.cpp` を含めるかどうかだけが違う。th06/th07 は含めず、th08 は含める
（fps 暴走検知用、touhou-recorder reports/22）。`score_monitor.cpp`（リプレイずれ
判定用のスコア監視、Issue #103）は3タイトルとも共通で含める。

```bash
cd worker/mods/th08_replay_autoplay
mkdir -p build
i686-w64-mingw32-g++ -shared -O2 -o build/th08_hook.dll \
  dllmain.cpp ../common/dinput_hook.cpp ../common/window_wait.cpp \
  ../common/logging.cpp ../common/fps_monitor.cpp ../common/score_monitor.cpp \
  -luser32 -static-libgcc -static-libstdc++
```

th06/th07 は上記コマンドから `../common/fps_monitor.cpp` を除いたもの（`dllmain.cpp`
を各ディレクトリのものに差し替える）。

## 関連

- ビルドした DLL の配布 → `upload-title-assets` skill
- MOD の設計・各フックの役割 → `worker/docs/mods.md`、`worker/docs/titles/thNN.md`
