# フェーズ78: th06nc(東方紅魔郷: New Classic)の環境構築と、GPU描画経路の必要性の判明

## 背景

2026年9月10日に発売された『東方紅魔郷：New Classic』(以下th06nc)を録画パイプラインに
乗せるための調査。ユーザーがゲーム資産を `games/th06nc/`(Steam配布データのコピー)、
検証用リプレイ24本を `games/th06nc/replay/` に配置済み。

作業開始前に `systemctl status sattori-home-worker` で本マシンのワーカーが停止中
(2026-09-10 19:42:58 以降 inactive)であることを確認した。

## 1. 静的解析: th06cと同系のエンジン

| 項目 | th06nc | th06c(フェーズ74) |
|---|---|---|
| アーキテクチャ | **PE32+ (x86-64)** | PE32+ (x86-64) |
| ファイルサイズ | 5,539,328 bytes | 4,039,168 bytes |
| エンジン | **DXライブラリ Ver3.24f**(文字列より) | DXライブラリ系 |
| レンダラ | D3D11優先 + D3D9フォールバック | 同左 |
| steam_api64.dll | **md5が th06c と完全一致**、インポートも同じ9関数 | — |
| 入力API | `GetKeyboardState`/`GetAsyncKeyState` を動的解決 | 同左 |
| Steam AppID | **4763590** | 4771400 |

```bash
x86_64-w64-mingw32-objdump -p games/th06nc/th06nc.exe | grep "DLL Name"
# steam_api64 / KERNEL32 / USER32 / ole32 / MSVCP140 / VCRUNTIME140(_1) / api-ms-win-crt-*
```

D3D系・DirectInput系の静的インポートは無く、`GetProcAddress` による動的解決である点も
th06cと同じ。したがって**フェーズ74で確立した手法(Steamworks APIスタブ +
GetProcAddressフックによる入力注入)がそのまま適用できる**見込み。

## 2. WINEPREFIXの構築

th06cと同じ手順(`WINEARCH=win64` が必須)。

```bash
WINEARCH=win64 WINEPREFIX=$PWD/prefixes/th06nc-wined3d-gl wineboot -u
WINEPREFIX=$PWD/prefixes/th06nc-wined3d-gl wineserver -w
bash ../sattori/worker/setup_wineprefix.sh "$PWD/prefixes/th06nc-wined3d-gl" \
    games/assets/msgothic.ttc games/assets/msmincho.ttc
WINEPREFIX=... wine reg add 'HKCU\Software\Wine\WineDbg' /v ShowCrashDialog /t REG_DWORD /d 0 /f
```

## 3. Steamクライアント要求の回避 — th06cのスタブがそのまま通用した

素で起動すると th06c と同じく即終了する。

```
SteamAPI_Init() failed. Steam must be running to play this game.  exit=255
```

`mods/th06c_steam_stub/build/steam_api64.dll`(フェーズ74のスタブ)を正規の
`steam_api64.dll` に上書き配置しただけで起動した。実機で要求されたインターフェースは
th06cよりさらに少なかった。

```
SteamAPI_RestartAppIfNecessary(appid=4763590) -> false
SteamInternal_SteamAPI_Init(versions=SteamUtils010) -> OK
SteamAPI_RegisterCallback(cb=..., id=331)          # GameOverlayActivated_t
SteamInput006::slot0() -> 0                        # Init(bool)
STEAMAPPS_INTERFACE_VERSION009::slot4() [GetCurrentGameLanguage] -> "japanese"
SteamInput006::slot6() -> 0
```

`SteamUtils010` のメソッドは一度も呼ばれず、`ResolveOverride()` への追加も不要だった。

## 4. 起動時ダイアログは**無い**

th06cは起動のたびに「解像度を選択してください」モーダルダイアログを出すが、th06ncには
そのダイアログが無い。実行ファイルに `ゲーム起動` / `VSync` といった文字列が存在せず
(`解像度` は DXライブラリ内部のログ文言のみ)、実機でもダイアログは出ずに
**`th06.env` の内容どおりのウィンドウが直接作られた**。

つまり `DismissStartupDialog()` 相当の処理はth06nc MODには不要。

### 4.1 `th06.env`(12バイト)の解像度エンコーディング

ユーザー提供の `th06.env.720p` / `th06.env.1080p` は **byte[5] のみが異なる**。
byte[5] を0〜7で総当たりして実機のウィンドウサイズを観測した
(`XVFB_SCREEN=2200x1400x24` のXvfb :91上)。

| byte[5] | 実際のウィンドウ |
|---|---|
| 0 | 1920x1080 |
| 1 | 2200x1400(画面いっぱい = 3840x2160指定がWMにクランプされたもの) |
| 2 | 2200x1400(同上、2560x1440相当) |
| **3** | **1920x1080**(= `th06.env.1080p`) |
| **4** | **1280x720**(= `th06.env.720p`) |
| 5〜7 | 2200x1400(画面いっぱい) |

**1280x720 より小さいウィンドウ解像度は選べない**(th06cの640x480に相当する選択肢が無い)。
なお byte[0] は th06nc=2 / th06c=3 で異なる(表示モードの種別と思われる)。

ウィンドウタイトルは `東方紅魔郷：New Classic　～ the Embodiment of Scarlet Devil.`。

## 5. 【最重要】llvmpipe(ソフトウェア描画)では60fpsに遠く届かない

既存8タイトルはすべて **Xvfb + wined3d(OpenGL) + llvmpipe(ソフトウェア描画)** で
60fpsが出ていたが、th06ncはこの経路では全く速度が足りない。ゲーム画面右下の
fps表示を実測した(タイトル画面、Ryzen 7 5700X / 16スレッド)。

| 解像度 | 実測fps | th06nc.exeのCPU使用率 |
|---|---|---|
| 1920x1080 | **5.1〜5.5 fps** | — |
| 1280x720 | **9.1 fps** | **約1300〜1400%(13〜14コアを占有)** |

画素数比 2.25倍に対して fps比は約1.7倍で、解像度を下げても線形には回復しない
(解像度非依存のCPUコストも大きい)。**1280x720がゲーム側で選べる最小解像度**である以上、
llvmpipeでの60fps達成は原理的に不可能と結論した。

## 6. GPU描画経路(headless weston + rootful Xwayland)で60fps達成

本マシンにはAMD Radeon VII(Vega 20、`/dev/dri/renderD128`、radeonsi/RADV)がある。
Xvfbは`DRI3`拡張を持たないためハードウェア描画が使えない(`reports/00`)が、
**headless backendのwestonを立て、その上にXwaylandを載せる**ことで、
X11として見えるGPU描画面を作れる。

```bash
sudo apt-get install -y weston xwayland    # Ubuntu 24.04の標準リポジトリ

export XDG_RUNTIME_DIR=/tmp/wl-th06nc && mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
weston --backend=headless --width=2200 --height=1400 --xwayland \
       --socket=wl-th06nc --renderer=gl &
# -> [weston] GL renderer: AMD Radeon Graphics (radeonsi, vega20, ACO, DRM 3.64, ...)
```

**`--renderer=gl` が必須**(既定はpixman=ソフトウェア)。

### 6.1 rootlessなXwaylandではx11grabが黒画面になる

westonが`--xwayland`で自動起動するXwaylandは**rootlessモード**で、X窓ごとに
Waylandサーフェスを持つ。この場合`DISPLAY=:1`のルートウィンドウには描画内容が
composite されず、**`ffmpeg -f x11grab` は真っ黒な画像しか取れなかった**
(`runs/th06nc_verification/78_gpu_title.png`)。

### 6.2 rootful Xwaylandを別に立てると x11grab がそのまま使える

```bash
export XDG_RUNTIME_DIR=/tmp/wl-th06nc WAYLAND_DISPLAY=wl-th06nc
Xwayland :2 -geometry 2200x1400 -noreset &
DISPLAY=:2 openbox --sm-disable &
```

`DISPLAY=:2` はルートウィンドウを持つ通常のX画面として振る舞い、Xvfbと同じ感覚で
`xwininfo` / `xdotool` / `ffmpeg -f x11grab` が使える。かつGLはハードウェアに出る。

```
DISPLAY=:2 glxinfo | grep "OpenGL renderer"
# -> OpenGL renderer string: AMD Radeon Graphics (radeonsi, vega20, ACO, DRM 3.64, ...)
```

### 6.3 実測結果

`DISPLAY=:2`(rootful Xwayland + GPU)で th06nc を1280x720で起動:

| 項目 | llvmpipe(Xvfb :91) | **GPU(Xwayland :2)** |
|---|---|---|
| 画面上のfps表示 | 9.1 fps | **60.00 / 60.00 / 60.00 / 60.01 fps** |
| th06nc.exeのCPU使用率 | 約1300〜1400% | **約0%** |
| x11grabキャプチャ | 可 | **可**(`78_gpu_title2.png` にタイトル画面が正常に写っている) |

**th06ncの録画にはGPU描画経路が必須**である。既存8タイトルのXvfb+llvmpipe前提とは
異なる実行基盤が必要になる。

## 7. 検証用リプレイの内容(`@sattori/touhou-replay-parser`)

`@sattori/touhou-replay-parser` は**すでにth06nc形式を認識できる**
(`Game: 東方紅魔郷: New Classic ～ the Embodiment of Scarlet Devil. (th06nc)`)。

```bash
node ../sattori/packages/replay-parser/dist/cli/index.js -j games/th06nc/replay/*.rpy
```

| ファイル | 難易度 | 自機 | スコア | ステージ | フレーム数 | 尺 |
|---|---|---|---|---|---|---|
| th6_01 | Easy | Marisa A | 49,260,900 | 1-5 | 61,312 | 17m01s |
| th6_02 | Normal | Reimu B | 90,668,470 | 1-6 | 87,290 | 24m14s |
| th6_03 | (None) | Reimu B | 5,710,640 | 6 | 1,063 | 0m17s |
| th6_04 | Hard | Marisa A | 103,229,340 | 1-6 | 87,443 | 24m17s |
| th6_05 | Hard | Marisa B | 22,647,970 | 1-3 | 22,381 | 6m13s |
| th6_06 | Lunatic | Reimu A | 44,139,720 | 1-3 | 37,022 | 10m17s |
| th6_07 | Easy | Reimu A | 514,850 | 1 | 1,265 | 0m21s |
| th6_08 | Lunatic | Reimu A | 113,214,810 | 1-6 | 74,476 | 20m41s |
| th6_09 | Hard | Reimu A | 91,645,280 | 1-6 | 105,355 | 29m15s |
| th6_10 | **Extra** | Reimu A | 68,468,720 | 7 | 45,388 | 12m36s |
| th6_11 | Hard | Marisa B | 112,894,530 | 1-6 | 92,275 | 25m37s |
| th6_12 | **Extra** | Marisa A | 69,590,490 | 7 | 24,905 | 6m55s |
| th6_13〜th6_23 | Easy〜Lunatic | 各種 | — | 1-5/1-6 | 60,773〜95,174 | 16m52s〜26m26s |
| th6_24 | **Extra** | Reimu B | 88,454,650 | 7 | 36,929 | 10m15s |

短尺の `th6_07`(Easy、21秒)・`th6_03`(17秒)は切り分け用に、`th6_05`(Hard、6m13s)・
`th6_12`(Extra、6m55s)は中尺検証に、`th6_04`(Hard、24m17s)・`th6_10`(Extra、12m36s)は
フル尺検証に使える。

`th6_03` は難易度が `None`・ステージ6のみ・17秒と、**スペルプラクティスのリプレイ**と
思われる(パーサーは難易度を解決できていない)。チャレンジモードのリプレイが
この24本に含まれているかは未確認。

## 8. 成果物

| パス | 内容 |
|---|---|
| `scripts/78_run_th06nc.sh` | 起動実験用ヘルパー(Xvfb :91 + wine後片付け付き) |
| `prefixes/th06nc-wined3d-gl/` | 64bit WINEPREFIX(gitignore) |
| `instances/th06nc-test/` | 検証用ゲームディレクトリコピー(gitignore) |
| `runs/th06nc_verification/78_bare_launch.png` | llvmpipeでのタイトル画面(5.66fps表示) |
| `runs/th06nc_verification/78_gpu_title2.png` | GPU経路でのタイトル画面(60.00fps表示) |

## 9. 次フェーズの課題

* リプレイ自動再生MODのth06nc版(起動ダイアログ処理は不要、メニューカーソル位置RVAと
  スコアRVAの特定が必要)
* `scripts/25_record_replay_e2e_multigame.py` への統合。**Xvfbではなく
  headless weston + rootful Xwayland を立てる経路を新設する必要がある**
* フル尺録画(通常ステージ・Extra)、録画品質・音ズレ・理論尺比較
* AWSクラウド実機検証。**GPUインスタンス(g4dn/g5/g6系)が前提になる**見込み

---

## 10. 【追記】リプレイ自動再生MODの実装と、起動時デッドロックの回避

`mods/th06nc_replay_autoplay/` をth06c版から派生させて作成した
(`dllmain.cpp` / `build_mingw.sh`)。Steamworks APIスタブ(`mods/th06c_steam_stub/`)と
`injector64.exe` はth06cのものをそのまま共用する。

th06c版からの主な差分:

* 起動ダイアログが無いので `DismissStartupDialog()` を削除し、代わりに
  「ダイアログが復活していないか」を確認するだけの `WarnIfStartupDialogPresent()` にした
* メニューカーソル位置・スコアのRVAは未特定のため、`kMenuIndexRva`/`kScoreRva` を `0` にし、
  `0` のときは「固定回数Downへフォールバック」「スコア監視を行わない」ようにした
  (`TH06NC_MENU_DOWNS` で回数を指定、既定3回)
* 環境変数のプレフィックスを `TH06C_` → `TH06NC_` に変更
* タイトル画面のキー入力受付開始待ちを 2000ms → 5000ms に延長(ユーザー提供情報より)

### 10.1 【重要】DllMainから生やしたスレッドがUSER32を早く触るとデッドロックする

移植直後、ゲームが起動せずwineが次のエラーを延々と出す状態になった。

```
0118:err:sync:RtlpWaitForCriticalSection section ... "dlls/ntdll/loader.c: loader_section"
      wait timed out in thread 0118, blocked by 0110, retrying (60 sec)
```

`TH06NC_BOOT`(`nothing` / `hooksonly` / `nolog` / 未指定)という切り分け用の環境変数を
MODに足して二分探索した結果、**原因は2つあった**。

| # | 原因 | 対策 |
|---|---|---|
| 1 | `ScoreMonitorThread` がRVA未特定時に **即 `return` していた**。スレッド終了時の `DLL_THREAD_DETACH` 通知でローダーロックを要求し、注入直後のローダーロック保持区間と競合する | `return` せず `for (;;) Sleep(60000);` で眠らせる |
| 2 | `AutoPlayThread` が起動直後に **`EnumWindows` を呼んでいた**。ゲーム本体はローダーロックを保持したまま winmm/xinput 等を順次ロードしており、その最中にEnumWindows(内部で winex11.drv 等のロードを要求しうる)を呼ぶとロック反転で両者が停止する | **ウィンドウ関連のUSER32呼び出しをすべて「入力ポーリング開始検出後」に移動**した。ポーリング回数はメモリ上のカウンタなのでUSER32に触らずに判定できる |

原因2はth06cでは顕在化しなかった。th06cは起動ダイアログのメッセージループが
早期に回るため、`DismissStartupDialog()` の `EnumWindows` が安全な時点で走っていたためと
考えられる。**DllMainから生やしたスレッドでUSER32のウィンドウ列挙を呼ぶのは、
ゲーム本体の初期化完了を待ってからにすること。**

### 10.2 実機動作確認

```bash
./mods/th06nc_replay_autoplay/build_mingw.sh
cp mods/th06nc_replay_autoplay/build/th06nc_hook.dll \
   mods/th06c_steam_stub/build/steam_api64.dll \
   mods/common/build/injector64.exe instances/th06nc-test/
cp games/th06nc/th06.env.720p instances/th06nc-test/th06.env
scripts/78_th06nc_diag.sh --tag mod --shots "30" --run-sec 60
```

MODログ(`instances/th06nc-test/th06nc_autoplay.log`)の要点:

```
入力ポーリング開始を検出(kbState=1 async=0)
StartupDialog: 1000 ms 監視しましたがダイアログは出ませんでした(想定どおり)
WaitForStableWindow: stable after 832 ms total
Step 1: Enter (デモ再生を抜けてメインメニューを表示)
Step 2: カーソル位置RVAが未特定のため Down を固定 3 回送ります
Step 3..5: Enter x3
=== th06nc_replay_autoplay: sequence complete ===
FpsMonitor: 301 GetDeviceState calls in 5006 ms (60.1 Hz)
FpsMonitor: 300 GetDeviceState calls in 5004 ms (60.0 Hz)
```

`runs/th06nc_verification/78_mod_t30.png` に、`th6_01.rpy`(Easy / Marisa A)の
STAGE1が **59.99fps** で再生され、画面下部に《REPLAY》表示が出ている様子が記録されている。
th06cと同様に**入力ポーリングは `GetKeyboardState` 経由**で、`GetAsyncKeyState` は
最後まで一度も呼ばれなかった(`async=0`)。

ユーザー提供の手順どおり **Down 3回で「Replay」に到達**することを確認した
(`games/th06nc/` には `score.dat` が無く、解放状況はクリーンな状態)。

---

## 11. 【追記・フェーズ79への申し送り】`scripts/25`への統合と、ホストGPUハングによる中断

### 11.1 `scripts/25_record_replay_e2e_multigame.py` へのth06nc統合

`GAME_CONFIGS["th06nc"]` を追加した。th06cのエントリからの主な差分:

| キー | 値 | 理由 |
|---|---|---|
| `display` | `:88` | `:92`はth09が使用中のため衝突を避けた |
| `gpu_display` | `True` | **新規キー**。Xvfbではなく`scripts/78_start_gpu_display.sh`を呼ぶ |
| `xvfb_screen` | `2200x1400x24` | 720p/1080pどちらのウィンドウ+装飾も収まるサイズ |
| `instance_dir` | `instances/th06nc-multigame-recording-test` | |
| `injector` | `injector64.exe` | th06cと共用(PE32+) |
| `hook_dll` | `th06nc_hook.dll` | |
| `extra_files` | steam_api64.dll(スタブ)+ `th06.env` | |
| `window_min_size` | `(600, 400)` | |
| `skip_origin_move_if_fits` | `True` | th06c/th09と同じ理由 |
| `end_template` | 未設定 | フル尺録画後に取得する(現状は画面静止検知のみ) |

`ensure_xvfb()` に `gpu_display` 分岐を追加し、指定時は `scripts/78_start_gpu_display.sh
--display <display> --screen <WxH>` を呼んで headless weston + rootful Xwayland + openbox を
立てるようにした(失敗時は例外)。

**`th06.env` はゲームが終了時に書き戻す**ことが判明した。720p(`byte[5]=4`)でコピーして
起動しても、終了後のインスタンスディレクトリには `020100000103000001000000`
(byte[4]=1, byte[5]=3)が残っていた。毎回 `extra_files` で上書きしないと解像度が
意図せず変わるため、`extra_files` に
`(TH06NC_ENV_FILE or games/th06nc/th06.env.720p, "th06.env")` を入れてある。
1080pで検証したい場合は `TH06NC_ENV_FILE=$PWD/games/th06nc/th06.env.1080p` を指定する。

`scripts/78_start_gpu_display.sh` のバグも2件修正した。

* `--stop` がソケットファイルを消していなかった。`kill -9` ではソケットが残るため、
  次回起動時に「westonは起動済み」と誤判定してXwaylandの接続だけが失敗していた
* weston起動済み判定を「ソケットファイルの有無」から「westonプロセスの生死」に変更

`scripts/78_run_th06nc.sh` / `scripts/78_th06nc_diag.sh` の既定DISPLAYも `:92` → `:88` に
揃えた。

### 11.2 【重大】ホストのGPU(Radeon VII / amdgpu)がハングし検証続行不能になった

統合後の初回E2E(`--replay th6_07.rpy`)で、MODログが
`GetProcAddress: XInputSetState` を最後に止まり、`WaitForStableWindow: stable` に
到達せずタイムアウトした。当初はMODのローダーロック対策の不備を疑ったが、切り分けの
結果**ホストのGPUがハングしていた**ことが分かった。

```bash
DISPLAY=:88 timeout 5 xdpyinfo    # -> タイムアウト(Xwaylandプロセスは生存)
ps -o pid,stat,wchan:25 -p <weston> <Xwayland>
#   Ssl futex_wait_queue   weston
#   Ssl futex_wait_queue   Xwayland
ps -eo stat | awk '$1 ~ /^D/' | wc -l     # -> 67
uptime                                     # -> load average: 70.34
```

D状態で固着していたのは `kworker/*+events`(`amdgpu_tlb_fence_work`)と
`kworker/u33:*+ttm`。カーネルログ:

```
Sep 12 04:40:54 kernel: INFO: task kworker/5:0:49 blocked for more than 122 seconds.
Sep 12 04:40:54 kernel: Workqueue: events amdgpu_tlb_fence_work [amdgpu]
Sep 12 04:40:54 kernel:  dma_fence_default_wait+0x1e1/0x220
Sep 12 04:40:54 kernel:  dma_fence_wait_timeout+0x116/0x140
Sep 12 04:40:54 kernel:  amdgpu_tlb_fence_work+0x29/0x140 [amdgpu]
```

最初の hung task 報告は 04:40:54 の「122秒以上ブロック」なので、**ハング開始は
04:38:52 頃**。本フェーズの weston 起動(04:40)より前であり、th06ncの描画が原因とは
断定できない。`/dev/dri/renderD128` はユーザーのML系ワークロード(`pt_main_thread` =
PyTorch、python 18プロセス)とも共有されている。

以降の症状はすべてこのGPUハングで説明がつく。

* ゲームが `XInputSetState` 以降進まない = 最初の描画呼び出しでGPUフェンス待ちに入る
* `kill -9` してもゾンビ(`Zl` / `Zsl`)のまま残る = `amdgpu_driver_postclose_kms` →
  `amdgpu_vm_fini` がフェンス待ちでブロックし、プロセスをreapできない
  (weston・Xwayland・th06nc.exeの3つで発生)
* 新しくGPUクライアントを起動するたびに `ttm` kworker のD状態固着が増える

**GPU描画を前提とするth06ncの録画検証は、ホストGPUが健全でないと一切進められない。**
ユーザー判断によりマシン再起動で復旧することとした。

### 11.3 次セッションで最初に確認すること

```bash
# GPUが健全か(D状態タスクが無いこと・load averageが正常なこと)
ps -eo stat | awk '$1 ~ /^D/' | wc -l
uptime
journalctl -k --since "-10min" | grep -i "amdgpu\|blocked for more than"

# GPU描画面が正常に立ち上がるか
scripts/78_start_gpu_display.sh --display :88 --screen 2200x1400
DISPLAY=:88 timeout 5 xdpyinfo >/dev/null && echo alive

# sattori-home-workerが停止していること
systemctl status sattori-home-worker
```

その上で、まず短尺リプレイ(`th6_07.rpy`、Easy・21秒)で
`scripts/25_record_replay_e2e_multigame.py --game th06nc --replay th6_07.rpy` の
E2Eを通すところから再開する。

**GPUハングが再発する場合**は、weston+Xwayland経路そのものの安定性を疑い、
代替として VirtualGL(`vglrun` でXvfb上のアプリのGLXだけをGPUへリダイレクト)の
検証も選択肢になる。

### 11.4 残タスク(新規タイトル対応チェックリスト基準)

| # | 項目 | 状態 |
|---|---|---|
| 1 | 設定確認(ウィンドウモード) | 完了(`th06.env`、720p/1080p) |
| 2 | 起動確認 | 完了 |
| 3 | MOD開発・動作確認 | 完了(リプレイ再生を実機確認) |
| 4 | フル尺録画(通常+Extra) | **未** |
| 5 | 録画品質確認 | **未** |
| 6 | 音ズレ確認 | **未** |
| 7 | 低速録画機能 | **未**(D3D11経路のため新規実装が必要。th06c同様スコープ外にするか要確認) |
| 8 | 内部データ取得(スコアRVA) | **未**(MODに`TH06NC_FIND_VALUE`探索機構は移植済み) |
| 9 | クラウド実機検証 | **未**(GPUインスタンス g4dn/g5/g6 前提) |
