# MOD(`mods/`)のソース構成

ゲームプロセスへ注入する C++ 製フック DLL とインジェクタの参照仕様。**フックを足す・
移植する・RVA を特定し直すときに、どのソースが何を担っているかをここで確かめること。**
ビルド手順は `build-mods` skill、タイトルごとに組み込むフックの違いは
[`titles/thNN.md`](titles/README.md)、ワーカー全体の構成は [`worker/README.md`](../README.md) §2。

`mods/` 配下はソースとビルドスクリプトのみ管理する(元は `touhou-recorder` の PoC 由来)。
ビルド成果物(`injector.exe`・`thNN_hook.dll`)はリポジトリに含めず、タイトル資産アーカイブ
として S3 へ置く(`worker/README.md` §8)。成果物の出力パス(`mods/common/build/injector.exe`・
`mods/thNN_replay_autoplay/build/thNN_hook.dll` など)はタイトル資産の配置そのものなので、
ソースの置き場所とは独立に固定してある。

> ソースは Issue #393 で共通基盤(`core/`)と機能別のディレクトリへ再編した。旧 `mods/common/` の
> ファイルとの対応と、再編で決めたこと(メニュー待ちの一本化など)は
> [`decisions/0076`](../../docs/decisions/0076-mod-core-and-present-bus.md)。

## 1. ディレクトリ

| ディレクトリ | 役割 |
| --- | --- |
| `core/` | バックエンドに依存しない基盤(§2)。全タイトルが使う |
| `clock/` | 時刻の差し替え(倍速録画のQPC偽装・fps表示の補正、§3)。#388 で仮想時計が入る |
| `input/` | キー入力の注入(DirectInput・`GetKeyboardState`・DXライブラリ向け、§4) |
| `present/` | Present のイベントバスと上限(§5) |
| `audio/` | 音声の周波数スケールと同期マーカー(§6) |
| `texture/` | 描画の補正(文字の縮小フィルタ・BC7展開、§7) |
| `monitor/` | スコア監視(デシンクの事後検知、§8) |
| `autoplay/` | メニュー操作の共通部(ウィンドウの安定待ち、th06c/th06ncの共通部) |
| `thNN_replay_autoplay/` | タイトルごとの自動再生MOD(`dllmain.cpp`)。組み込むフックの違いは各タイトルの背景ファイル |
| `tools/` | インジェクタ(`injector.cpp`、複数DLLの順次注入)・Steamworks APIスタブ(`steam_stub.cpp`、`-DAPP_ID`・`-DLOG_NAME` でth06c用・th06nc用の2つをビルド) |
| `tests/` | Win32 に依存しないロジックの単体テスト(ホストの g++、`make test`)とログ契約のゴールデン(§9) |

タイトルが使うモジュールは `Makefile` の「タイトルの宣言」(`thNN_ARCH`・`thNN_MODS`・
`thNN_STATIC`)で決まる。ソースは `"core/log.h"` のように `mods/` からのパスで include する。

## 2. 共通基盤(`core/`)

| ソース | 役割 |
| --- | --- |
| `core/log.*` | MODログ(`thNN_autoplay.log`)。契約行は `LogStep()`・`LogSequenceComplete()` で出す |
| `core/log_contract.h` | **ワーカーが正規表現・部分一致で読む行の書式**(`Step N:`・`sequence complete`・`WaitForStableWindow: stable`・`ScoreMonitor: ...`・`SYNC_MARKER played ...`・行頭の時刻)。変えるときは読む側(`recording/modlog.py`・`sync_marker.py`・`pipeline.py`)も直す。両側のテストが同じゴールデンを読む(§9) |
| `core/runtime_config.*` | **MODが読む環境変数はここでだけ読む**(DllMainで1回)。`FPS_LIMIT_TARGET_HZ`・`SPEED_HACK_MULTIPLIER`・`SYNC_MARKER_TRIGGER`・`D3D11_DECODE_BC7`・`D3DX_AREA_FILTER`、手動の検証専用の `MENU_WAIT_EXTRA_SCALE`。読んだ値は `RuntimeConfig:` の行でログへ出す |
| `core/time_scale.h` | メニュー操作の待ち(`MenuSleep`、`60/FPS_LIMIT_TARGET_HZ` 倍)と、実時間で進む起動待ちの上限(`StartupTimeout`、低速録画でだけ伸ばす)。**タイトル側で待ちの倍率を計算しないこと** |
| `core/pe_iat.*` | IATの書き換え(名前・序数・DLL名の前方一致)と、`GetProcAddress` の横取りの登録表(`procaddr::Override`) |
| `core/vtable_hook.h` | COMの vtable の書き換え。**冪等**(すでにフック済みなら何もしない。Wineは同じ型のオブジェクトで vtable を共有するので、二重にパッチすると無限再帰になる) |
| `core/code_patch.*` | バイト照合つきのコードの書き換え(th12 の fps 表示のコードケーブ) |

## 3. 時刻(`clock/`)・録画速度(`worker/README.md` §5)

いずれも`FPS_LIMIT_TARGET_HZ`・`SPEED_HACK_MULTIPLIER`が未設定(等倍)なら従来動作と互換。

| ソース | 役割 |
| --- | --- |
| `clock/speed_hack.*` | 倍速録画(Issue #288)の本体。`QueryPerformanceCounter`(と、64bitタイトルでは`GetProcAddress`経由の`timeGetTime`)の経過時間を`SPEED_HACK_MULTIPLIER`倍に伸ばし、ゲームに「時間がN倍速く進んだ」と思わせる(touhou-recorder reports/85)。全32bitタイトルに組み込み、64bitのth06c/th06ncは`GetProcAddress`経由の取得を差し替える |
| `clock/fps_display.*` | 画面に焼き付くfpsカウンター表示だけを等倍相当へ補正する(reports/48)。`clock/speed_hack`が同じAPIを偽装済みの場合はその倍率を割り戻す(二重補正で th12/th20が「30fps」になった、reports/90)。**`InstallSpeedHackHook()`の後に呼ぶこと**。th06/th08はfps計算が`timeGetTime`なのでtimeGetTime版を使う |
| `clock/time_warp.h` | 上の2つが使う時刻の写像(基準からの経過を倍率で伸縮する) |

## 4. 入力(`input/`)

| ソース | 役割 |
| --- | --- |
| `input/dinput.*` | `DirectInput8Create` → `CreateDevice` → `GetDeviceState` の連鎖でキーを注入する(`PressKey`、DIKコード)。TH10以降の一部(th11・th20)は `GetKeyboardState` のIATフック(`PressVKey`)。どちらの経路を使うかはタイトルごとに実機で確かめてある([titles/](titles/README.md)) |
| `input/dxlib_input.*` | th06c/th06nc(DXライブラリ)向け。`GetKeyboardState`(th06ncは`GetAsyncKeyState`も)を`GetProcAddress`経由で差し替える |
| `input/key_inject.h` | 押し離しの共通部。単位はミリ秒ではなく**ポーリングの回数**(タイトルでfpsが10倍以上違うため) |

## 5. Present(`present/`)

| ソース | 役割 |
| --- | --- |
| `present/bus.*` | Present のイベントバス。前後のハンドラを優先度順に呼び、前のハンドラは `kThrottle`(上限の待ちを行う、既定で立つ)・`kSkip`(本来のPresentを呼ばない)を決める。**#388 のフレーム同期はここへハンドラを登録する形で入る** |
| `present/d3d9.cpp`・`d3d8.cpp` | `Direct3DCreate9/8` → `CreateDevice` → `Present` の薄いアダプタ(D3D8はth09、vtable番号はD3D9よりCreateDeviceが1つ・Presentが2つ小さい) |
| `present/dxgi.cpp` | `IDXGISwapChain::Present` のアダプタ。**#388 で使う予定で、まだどのタイトルにも組み込んでいない**(コンパイルだけ CI で確かめている) |
| `present/limiter.*` | Present の上限(reports/46)。目標fpsは`FPS_LIMIT_TARGET_HZ`(既定60)。倍速録画では`60×倍率`へ引き上げる。th10/th12 は等倍では組み込まない(VsyncPatchと二重の制御になる、[titles/th10.md](titles/th10.md)) |

## 6. 音声(`audio/`)

| ソース | 役割 |
| --- | --- |
| `audio/dsound.*` | 音声の再生周波数を`FPS_LIMIT_TARGET_HZ/60`倍にスケールする(`SetFrequency`フック、reports/47・89)。同期マーカーはゲーム自身のDirectSoundデバイスでバッファを作って鳴らす |
| `audio/wasapi.*` | th06c/th06nc(音声はWASAPI)向けの`audio/dsound`相当。`GetMixFormat`のレートを1/倍率に見せ、`Initialize`で倍率ぶん戻して実ストリームを開く。同期マーカーは`ReleaseBuffer`で出力バッファへ足し込む(reports/89・90) |
| `audio/sync_marker.*` | **同期マーカー**(reports/88)の共通部: `SYNC_MARKER_TRIGGER`のファイルの監視、壁時計、`SYNC_MARKER played ...`の行。等倍でも有効。系列(`sync_marker_sequence.h`、xorshift32)は `recording/sync_marker.py` と一致させること(§9のゴールデンで確かめる) |

## 7. 描画の補正(`texture/`)

| ソース | 役割 |
| --- | --- |
| `texture/d3dx_filter.*` | `D3DXLoadSurfaceFromMemory`のIATフック。縮小を伴いフィルタがLINEAR/TRIANGLE/BOXの転送をMOD側でテント縮小(半径0.8×縮小率、計算は `area_resample.h`)してから`D3DX_FILTER_NONE`で元の関数へ渡し、Wineの内蔵d3dx9が最近傍で間引くせいで会話文・スペルカード名がジャギーになるのを防ぐ。th10・th11・th12・th128・th13に組み込み、既定で有効(`D3DX_AREA_FILTER=0`で無効)([`decisions/0071`](../../docs/decisions/0071-d3dx-text-downscale-filter-in-mod.md)) |
| `texture/d3d11_bc7.*` | th06ncのCPU描画用に、BC7テクスチャをロード時にRGBA8へ展開する(`D3D11_DECODE_BC7=1`のときだけ、reports/96)。デコーダは `bc7_decode.h` |

## 8. スコア監視(`monitor/`、デシンク事後検知)

| ソース | 役割 |
| --- | --- |
| `monitor/score_monitor.*` | ゲーム内スコア・ステージ番号・残機・グレイズの定期サンプリング(reports/50、Issue #103)。`recording.modlog.check_replay_desync()`が録画成功直後にMODログのスコア推移と`replayInfo.score`を突き合わせてリプレイずれ(デシンク)の疑いを判定する(`JobRecord.desyncDetected`、自動リトライはしない。ただし期待スコア>0に対し最後までスコアが0のままだった録画はリプレイ非再生とみなして自動リトライする、Issue #324)。RVAはタイトル毎に`dllmain.cpp`で指定(baseRva+baseIsPointer+フィールドオフセット/幅の汎用設計、値の読み取りは `score_read.h`)。th09を除く全タイトルで実機動作確認済み([`docs/reports/2026-08-25-th07-score-monitor-fix.md`](../../docs/reports/2026-08-25-th07-score-monitor-fix.md)、`docs/known-limitations.md`参照。th07だけはSattoriが配布するth07.exeが当初の検証環境とバイナリが異なりRVAの再特定を要した)。**th09だけはスコアのRVAが未特定のため`scoreWidth=0`でスコア読み取りを無効化し、life(残機)のみ監視する**([titles/th09.md](titles/th09.md)参照) |
| `research/archive/mod-probes/`(`score_probe_hook.*` / `stage_probe_hook.*`) | RVA特定用の診断専用コード。ビルドされないため`mods/common/`から移した(Issue #392)。score_monitorのRVAが通用しないタイトル・ゲームバージョンが出た場合の再調査の参考にする |

## 9. テストと検査

| コマンド | 内容 |
| --- | --- |
| `make -C worker/mods test` | `tests/test_*.cpp`(ホストの g++): BC7展開・文字の縮小・時刻の写像・メニュー待ちの倍率・環境変数の読み取り・スコアの幅ごとの読み取り・ログ契約・同期マーカーの系列 |
| `make -C worker/mods check-imports` | 全DLL・EXEのインポートに MinGW のランタイム(`libgcc_s`・`libstdc++`・`libwinpthread`)が出ていないか(出ると注入に失敗する、th20) |
| `make -C worker/mods check-compile` | どのタイトルにも組み込んでいないソース(`present/dxgi.cpp`)もコンパイルできるか |
| `worker/tests/test_mod_log_contract.py` | `tests/log_contract_golden.txt`(MOD側のテストが同じ書式で再現する行)をワーカーの正規表現で読めるか、`tests/sync_marker_golden.txt` が `recording/sync_marker.py` の系列と一致するか |

CI(`.github/workflows/test.yml` の `mods-build-smoketest`)は `make all check` を実行する。
**実機注入の代わりにはならない**ので、MODを変えたら MOD 統合テスト
([`mod-integration-test.md`](mod-integration-test.md))と実録画で確かめること。
