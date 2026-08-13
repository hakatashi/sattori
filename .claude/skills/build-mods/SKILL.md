---
name: build-mods
description: 東方タイトルの録画用 MOD（`thNN_hook.dll`）を mingw-w64 でクロスビルドする手順（th11・th20）。「hook DLL をビルドして」「MOD をビルドし直して」等で使う。th20 は `-static` が必須、th06/07/08/11 のビルド済み DLL はソースと乖離しているなど、知らないと DLL 注入が失敗する注意点があるため必ずこの手順に従うこと。
---

# MOD（`*_hook.dll`）のビルド

このマシンには Windows/MSVC 環境がないため、`i686-w64-mingw32-g++` でクロスビルドしている
（実機注入テストで MSVC ビルドと同一挙動を確認済みという知見に基づく採用、
touhou-recorder reports/25）。正式な本番ビルド手順は MSVC 想定
（`worker/README.md` §9 参照。MSVC 経路の廃止は Issue #102）。

ビルド成果物（`mods/**/build/`）は gitignore 済みで、S3 のタイトル資産アーカイブに
同梱して配布する（`upload-title-assets` skill）。**MOD を再ビルドしたら、必ず
タイトル資産も再アップロードすること**。しないと本番は古い DLL のまま動く。

## th11

```bash
cd worker/mods/th11_replay_autoplay
mkdir -p build
i686-w64-mingw32-g++ -shared -O2 -o build/th11_hook.dll \
  dllmain.cpp ../common/dinput_hook.cpp ../common/window_wait.cpp \
  ../common/logging.cpp ../common/fps_monitor.cpp \
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
（fps 暴走検知用、touhou-recorder reports/22）。

```bash
cd worker/mods/th08_replay_autoplay
mkdir -p build
i686-w64-mingw32-g++ -shared -O2 -o build/th08_hook.dll \
  dllmain.cpp ../common/dinput_hook.cpp ../common/window_wait.cpp \
  ../common/logging.cpp ../common/fps_monitor.cpp \
  -luser32 -static-libgcc -static-libstdc++
```

## MSVC（正式なビルド経路。このマシンでは実行できない）

**Windows + Visual Studio (C++ x86/x64 tools)** が必要（ゲームが 32bit ネイティブ Win32
バイナリのため MSVC の x86 ツールチェーンでビルドする）。x86 Native Tools Command Prompt
for VS、または通常のコマンドプロンプトから:

```bat
worker\mods\common\build_injector.bat
worker\mods\th06_replay_autoplay\build.bat
worker\mods\th07_replay_autoplay\build.bat
worker\mods\th08_replay_autoplay\build.bat
worker\mods\th11_replay_autoplay\build.bat
worker\mods\th20_replay_autoplay\build.bat
```

- `build_injector.bat` は `setup_vcvars.bat`（vswhere.exe で VS を検出し `vcvars32.bat` を
  呼ぶ）経由で環境を整えてから `cl.exe` で `mods/common/build/injector.exe` を生成する
  （タイトル非依存の共通バイナリ。複数 DLL の順次注入に対応し、th06 の VsyncPatch と MOD
  本体の共存に使う）。
- 各 `build.bat` がリンクするソースの組み合わせは上記の mingw コマンドと同じ
  （th06/th07 は `dinput_hook` / `window_wait` / `logging`、th08/th11 は `fps_monitor` を
  追加、th20 はさらに `fps_limiter_hook` / `dsound_hook` / `fps_display_hook` /
  `score_monitor`)。th11 は `InstallKeyboardStateHook` を使うが、リンクするソースファイル
  自体は th08 と同じ構成。

## th06 / th07 / th08 のビルド済み DLL はソースと乖離している

`mods/common/dinput_hook.cpp` は th20 対応で修正が入っている（`DirectInput8Create` の
二重呼び出しによる無限再帰の防止、touhou-recorder reports/44）。th06/th07/th08/th11 の
ビルド済み DLL には未反映で、**現状は無害だがソースとは乖離している**。

これらの MOD を次に触る際は本修正込みで再ビルドし、タイトル資産を再アップロードすること
（`upload-title-assets` skill）。

## 関連

- ビルドした DLL の配布 → `upload-title-assets` skill
- MOD の設計・各フックの役割 → `worker/README.md` §2、`worker/docs/titles/thNN.md`
