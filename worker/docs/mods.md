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

> ソースは Issue #393 で共通基盤(`core/`)と機能別のディレクトリへ再編し、Issue #388 で
> `touhou-recorder` からフレーム同期キャプチャ(`clock/virtual_clock*`・`present/capture/`・
> `audio/virtual/`)を移植した。再編の経緯は
> [`decisions/0076`](../../docs/decisions/0076-mod-core-and-present-bus.md)。

## 1. ディレクトリ

| ディレクトリ | 役割 |
| --- | --- |
| `core/` | バックエンドに依存しない基盤(§2)。全タイトルが使う |
| `clock/` | 時刻の差し替え(倍速録画のQPC偽装・fps表示の補正・フレーム同期の仮想時計、§3) |
| `input/` | キー入力の注入(DirectInput・`GetKeyboardState`・DXライブラリ向け、§4) |
| `present/` | Present のイベントバスと上限・フレーム同期キャプチャ(§5) |
| `audio/` | 音声の周波数スケール・同期マーカー・フレーム同期用仮想ミキサ(§6) |
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
| `core/log_contract.h` | **ワーカーが正規表現・部分一致で読む行の書式**(`Step N:`・`sequence complete`・`WaitForStableWindow: stable`・`ScoreMonitor: ...`・`SYNC_MARKER played ...`・`FrameSync: capture start / unthrottled / capture stopped`・行頭の時刻)。変えるときは読む側(`recording/modlog.py`・`sync_marker.py`・`pipeline.py`)も直す。両側のテストが同じゴールデンを読む(§9) |
| `core/runtime_config.*` | **MODが読む環境変数はここでだけ読む**(DllMainで1回)。通常録画用(`FPS_LIMIT_TARGET_HZ`・`SPEED_HACK_MULTIPLIER`・`SYNC_MARKER_TRIGGER`・`D3D11_DECODE_BC7`・`D3DX_AREA_FILTER`・検証専用の `MENU_WAIT_EXTRA_SCALE`)を `RuntimeConfig:` へ出し、`FRAME_SYNC_PIPE` 設定時は追加で 9 種のフレーム同期変数(`FRAME_SYNC_PIPE`・`FRAME_SYNC_STOP`・`FRAME_SYNC_AUDIO`・`FRAME_SYNC_STEP_DIV`・`FRAME_SYNC_SKIP_PRESENT`・`FRAME_SYNC_PIPELINE`・`FRAME_SYNC_THROTTLE_WHILE_THREADS`・`FRAME_SYNC_THREAD_MAX_MS`・`FRAME_SYNC_AUDIO_REFILL_WAIT_MS`)を `RuntimeConfig(FrameSync):` で出す |
| `core/time_scale.*` | メニュー操作の待ち(`MenuSleep`、通常時は `60/FPS_LIMIT_TARGET_HZ` 倍、フレーム同期時は `SetMenuSleepHandler` で Present 基準へ切り替え)と、実時間で進む起動待ちの上限(`StartupTimeout`、低速録画でだけ伸ばす)。**タイトル側で待ちの倍率を計算しないこと** |
| `core/pe_iat.*` | IATの書き換え(名前・序数・DLL名の前方一致、複数DLLへの冪等な適用)と、`GetProcAddress` の横取りの登録表(`procaddr::Override`) |
| `core/vtable_hook.h` | COMの vtable の書き換え。**冪等**(すでにフック済みなら何もしない。Wineは同じ型のオブジェクトで vtable を共有するので、二重にパッチすると無限再帰になる) |
| `core/code_patch.*` | バイト照合つきのコードの書き換え(th12 の fps 表示のコードケーブ) |

## 3. 時刻(`clock/`)・録画速度(`worker/README.md` §5)

`FRAME_SYNC_PIPE` が未設定で、`FPS_LIMIT_TARGET_HZ`・`SPEED_HACK_MULTIPLIER` も未設定(等倍)なら従来動作と完全互換。フレーム同期有効時(`Config().FrameSyncEnabled()`)は `speed_hack` と `fps_display` は組み込みをスキップし、`virtual_clock` が時刻を一元管理する。

| ソース | 役割 |
| --- | --- |
| `clock/speed_hack.*` | 倍速録画(Issue #288)の本体。`QueryPerformanceCounter`(と、64bitタイトルでは`GetProcAddress`経由の`timeGetTime`)の経過時間を`SPEED_HACK_MULTIPLIER`倍に伸ばし、ゲームに「時間がN倍速く進んだ」と思わせる(touhou-recorder reports/85) |
| `clock/fps_display.*` | 画面に焼き付くfpsカウンター表示だけを等倍相当へ補正する(reports/48)。`clock/speed_hack`が同じAPIを偽装済みの場合はその倍率を割り戻す(reports/90)。**`InstallSpeedHackHook()`の後に呼ぶこと**。th06/th08はtimeGetTime版を使う |
| `clock/time_warp.h` | 上の2つが使う時刻の写像(基準からの経過を倍率で伸縮する) |
| `clock/virtual_clock.*`・`virtual_clock_math.h` | フレーム同期用仮想時計(Issue #388)。`FRAME_SYNC_PIPE` 設定時のみ `QPC`/`timeGetTime`/`GetTickCount`/`GetTickCount64`/`Sleep`(および `vpatch_th{06,07,10,12}.dll` IAT・オプションで待機構文タイマ/スレッド追跡)をフックする。DXライブラリ向けには `GetProcAddress` ラッパ(`Wrap*`)を提供 |

## 4. 入力(`input/`)

| ソース | 役割 |
| --- | --- |
| `input/dinput.*` | `DirectInput8Create` → `CreateDevice` → `GetDeviceState` の連鎖でキーを注入する(`PressKey`、DIKコード)。TH10以降の一部(th11・th20)は `GetKeyboardState` のIATフック(`PressVKey`)。どちらの経路を使うかはタイトルごとに実機で確かめてある([titles/](titles/README.md)) |
| `input/dxlib_input.*` | th06c/th06nc(DXライブラリ)向け。`GetKeyboardState`(th06ncは`GetAsyncKeyState`も)を`GetProcAddress`経由で差し替える |
| `input/key_inject.h` | 押し離しの共通部。単位はミリ秒ではなく**ポーリングの回数**(タイトルでfpsが10倍以上違うため)。`FRAME_SYNC_PIPE` 有効時、D3D11/DXライブラリタイトルでは `PressVKey` 待ちをフレーム待機へ委譲する |

## 5. Present(`present/`)・フレーム同期キャプチャ(`present/capture/`)

| ソース | 役割 |
| --- | --- |
| `present/bus.*` | Present のイベントバス。前後のハンドラを優先度順に呼び、前のハンドラは `kThrottle`・`kSkip` を決める。フレーム同期ハンドラ(`kPriorityFrameSync=50`)は `present/limiter`(`kPriorityLimiter=100`)より先に走り、アンロック中の `kThrottle` を落とす |
| `present/d3d9.cpp`・`d3d8.cpp` | `Direct3DCreate9/8` → `CreateDevice` → `Present` のアダプタ。**th06・th07・th08・th09 は D3D8、th10〜th20 は D3D9**(D3D8はvtable番号がCreateDeviceで1つ・Presentで2つ小さい) |
| `present/dxgi.cpp` | `IDXGISwapChain::Present`・`ResizeBuffers` のアダプタと `WrapD3D11CreateDevice*` / `WrapCreateDXGIFactory*`(`th06c`・`th06nc` で使用) |
| `present/limiter.*` | Present の上限(reports/46)。目標fpsは`FPS_LIMIT_TARGET_HZ`(既定60)。リアルタイム時に `limiter` を積まないタイトル(`th06`・`th07`・`th08`・`th10`・`th11`・`th12`)では、`FRAME_SYNC_PIPE` 未設定時に Present 自体をフックしない |
| `present/capture/frame_sync.*` | フレーム同期コーディネータ。最初の Present で仮想時計を開始し、`MENU_WAIT`/シーケンス完了時に上限を解除(`SetUnthrottled(true)`)、Present ごとに仮想時計の進行・バックバッファ読み出し・仮想音声ミキシングを駆動する |
| `present/capture/pipe_writer.*`・`pixel_format.h`・`readback.h`・`d3d_surface_capture.h` | FIFOパイプ書き込み(任意ストライド行書き・ピクセル形式変換)と D3D8/D3D9 共有のPOD読み出し基盤(パイプライン読み出しと `GetRasterStatus` フック) |
| `present/capture/d3d8_readback.*`・`d3d9_readback.*`・`d3d11_readback.*` | バックエンド別エントリ。`InstallFrameSyncD3D8`(th06 は `stepDiv=1024`、th07/th08/th09 は `32`)、`InstallFrameSyncD3D9`(th10/th11/th12/th128/th13/th15/th20 は `1024`)、`InstallFrameSyncD3D11`(th06c/th06nc は `64`)。すべて `FRAME_SYNC_PIPE` 未設定時は `false` を返して何もしない |

## 6. 音声(`audio/`)・仮想ミキサ(`audio/virtual/`)

| ソース | 役割 |
| --- | --- |
| `audio/dsound.*` | 音声の再生周波数を`FPS_LIMIT_TARGET_HZ/60`倍にスケールする(`SetFrequency`フック、reports/47・89)。`CreateSoundBuffer` / `DuplicateSoundBuffer` でフレーム同期用ミキサへバッファを通知 |
| `audio/wasapi.*` | th06c/th06nc(音声はWASAPI)向けの`audio/dsound`相当。`GetMixFormat`・`Initialize`・`ReleaseBuffer` をフック |
| `audio/sync_marker.*` | 同期マーカー(reports/88)の共通部。**フレーム同期有効時(`Config().FrameSyncEnabled()`)は無効化する**(仮想音声は先頭フレームから映像と決定論的に一致するため不要) |
| `audio/virtual/dsound_mixer.*`・`wasapi_mixer.*`・`mix_math.h` | `FRAME_SYNC_AUDIO` 設定時のみ有効な仮想音声ミキサ(44100Hz s16le 2ch RAW PCM をフレーム毎に生成)。STL 非依存で書かれ、`dsound_mixer` は全32bit DirectSound タイトル、`wasapi_mixer` は `th06c`/`th06nc` の `IMMDeviceEnumerator` (`CoCreateInstance` 経由、ローダーロックを避けた遅延ファイルオープン)を担当 |

## 7. 描画の補正(`texture/`)

| ソース | 役割 |
| --- | --- |
| `texture/d3dx_filter.*` | `D3DXLoadSurfaceFromMemory`のIATフック。Wineの最近傍間引きによる文字ジャギーを防ぐためテント縮小を行う。th10・th11・th12・th128・th13に組み込み、既定で有効(`D3DX_AREA_FILTER=0`で無効)([`decisions/0071`](../../docs/decisions/0071-d3dx-text-downscale-filter-in-mod.md)) |
| `texture/d3d11_bc7.*` | th06ncのCPU描画用に、BC7テクスチャをロード時にRGBA8へ展開する(`D3D11_DECODE_BC7=1`のときだけ、reports/96)。デコーダは `bc7_decode.h` |

## 8. スコア監視(`monitor/`、デシンク事後検知)

| ソース | 役割 |
| --- | --- |
| `monitor/score_monitor.*` | ゲーム内スコア・ステージ番号・残機・グレイズの定期サンプリング(reports/50、Issue #103)。倍速時は間隔を `1/倍率` に、フレーム同期時は高倍速での終端取りこぼし防止のため上限 `20ms` へ詰めて動作する。RVAはタイトル毎に`dllmain.cpp`で指定(`th09` は `scoreWidth=0` で life のみ監視、[titles/th09.md](titles/th09.md)参照) |
| `research/archive/mod-probes/` | RVA特定用の診断専用コード(ビルド対象外) |

## 9. テストと検査

| コマンド | 内容 |
| --- | --- |
| `make -C worker/mods test` | `tests/test_*.cpp`(ホストの g++): BC7展開・文字縮小・時刻写像・メニュー待ち倍率・環境変数(フレーム同期含む)・仮想時計・音声ミキシング・ピクセル形式変換・スコア読み取り・ログ契約(FrameSync 3行含む)・同期マーカー系列 |
| `make -C worker/mods check-imports` | 全DLL・EXE(17ファイル)のインポートに MinGW ランタイム(`libgcc_s`・`libstdc++`・`libwinpthread`)が出ていないか確認(`KERNEL32.dll`・`msvcrt.dll`・`USER32.dll` 等のみ) |
| `make -C worker/mods check-compile` | `CHECK_ONLY_SRCS_64` のコンパイル確認(`present/dxgi.cpp` は `th06c`/`th06nc` に組み込み済みのため現在空) |
| `worker/tests/test_mod_log_contract.py` | `tests/log_contract_golden.txt`(SyncMarker・FrameSync 3行を含む8行)と `tests/sync_marker_golden.txt` をワーカー側正規表現・Python 実装と突き合わせる |

CI(`.github/workflows/test.yml` の `mods-build-smoketest`)は `make all check` を実行する。
**実機注入の代わりにはならない**ので、MODを変えたら MOD 統合テスト
([`mod-integration-test.md`](mod-integration-test.md))と実録画で確かめること。
