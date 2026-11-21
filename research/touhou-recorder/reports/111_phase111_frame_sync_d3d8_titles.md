# フェーズ111: D3D8 4タイトル (`th06`, `th07`, `th08`, `th09`) へのフレーム同期キャプチャ展開

## 1. 概要と結論

D3D8＋DirectSound8系4タイトル（`th06`, `th07`, `th08`, `th09`）へフレーム同期キャプチャ（`--frame-sync`: D3D8 バックバッファ読み出し＋仮想時計＋DirectSound仮想音声デバイス）を実装し、ローカル（Xvfb + wined3d + llvmpipe、CPU描画、無負荷逐次実行）でプローブ・スモーク検証・フル尺8本を実施した。

- **全4タイトル・全8本が試行1回で完走、映像・音声フレーム数完全一致 (`frames_written == video_frames == audio_frames`, 音声端数 `0` バイト)、`unknown_plays = 0`**。
- **`th06`/`th07`/`th08` 全6本で `scripts/53_verify_replay_score.py` が「一致(デシンクなし)」**（`th09` は `ScoreMonitor` の残機遷移 `10 → 5 → 1` 等と再生長を検証）。
- ローカル（Ryzen 7 5700X / 16スレッド）での上限解除平均速度（`run.log` 計測）:
  - `th06`: **`5.08x` (`304.8fps`)** (`th6_ud1bws`)、**`4.47x` (`268.2fps`)** (`th6_02` — ただしローカルディスク上の `games/th06/bgm/th06_05.wav` 破損に伴う補充待ちを除くと **`~5.14x`**)
  - `th07`: **`5.37〜5.74x`** (`322.2〜344.1fps`)
  - `th08`: **`5.29〜5.46x`** (`317.1〜327.4fps`)
  - `th09`: **`4.57〜4.92x`** (`274.1〜294.9fps`)
- D3D8 特有の4課題（(1) Shift-JIS プロセス名による MOD ログデコード例外、(2) `th07`/`08`/`09` のビジーウェイト QPC ループによる低速化、(3) `th07`/`08`/`09` 起動画面の 60Hz VSync キャリブレーション待ちによる30秒タイムアウト、(4) マルチデバイス切替時のサーフェス再生成）をすべて特定・解消した。

---

## 2. DSOUND_PROBE=1 調査結果

`FRAME_SYNC` 無効・`DSOUND_PROBE=1` で各タイトル60秒のプローブ（出力 `/mnt/cache3/sattori-th0*-verify/phase106/p111_probe/`）を実施した結果、4タイトルすべてが既存の `mods/common/frame_sync_audio.cpp` と互換な **静的SE + `DuplicateSoundBuffer` + `IDirectSoundNotify` 通知駆動循環BGMバッファ** 構成であることを確認した。

| タイトル | `CreateSoundBuffer` 累計 | `DuplicateSoundBuffer` | BGMバッファ形式・サイズ | 通知ポイント (`notify count`) |
|---|---|---|---|---|
| `th06` | `60` | `32` | `352,800B` (`2.0s`), `44100Hz/2ch/16bit`, `flags=0x18188` | `count=4` (`88199, 176399, 264599, 352799`), SEは主に `22050Hz/1ch/8bit` |
| `th07` | `73` | `38` | `705,600B` (`4.0s`), `44100Hz/2ch/16bit` | `count=16` (`44099..705599`, 44,100B間隔) |
| `th08` | `89` | `46` | `705,600B` (`4.0s`), `44100Hz/2ch/16bit` | `count=16` (`44099..705599`) |
| `th09` | `99` | `54` | `705,600B` (`4.0s`), `44100Hz/2ch/16bit` | `count=16` (`44099..705599`) |

あわせて `th06` 実行時に `東方紅魔郷.exe` 由来の Shift-JIS バイト列で `UnicodeDecodeError` が発生していた `recorder/modlog.py`（`wait_for_log_marker` L52・`scan_fps_runaway` L74）を `encoding="utf-8", errors="replace"` に修正した。

---

## 3. D3D8 実装内容と特定した固有課題

### 3.1 D3D8 バックバッファ取り込みと共通パイプライン配線
- `mods/common/frame_sync_hook.{h,cpp}`:
  - `InstallFrameSyncHook(int stepDiv = 1024)` へ拡張し、`g_d3d8PrePresentCallback` / `g_d3d8PostPresentCallback` を登録。
  - `CaptureFrameD3D8(void* dev)`: D3D8 COM vtable オフセットに従い `IDirect3DDevice8::GetBackBuffer` (`vtable[16]`), `IDirect3DSurface8::GetDesc` (`vtable[8]`), `CreateImageSurface` (`vtable[27]`), `CopyRects` (`vtable[28]`), `LockRect`/`UnlockRect` (`vtable[9]`/`[10]`)、および `GetRasterStatus` (`vtable[17]`, `MyGetRasterStatus8`) を使用。パイプライン化（`g_surfs[0..1]` の2面トグル）により1フレーム遅延書き込みを維持。
  - Multi-device 対応の `ResetCaptureDevice(void* newDev)`: `dev` ポインタ変化時に未書き出しサーフェス（`g_pendingSurf`）をフラッシュし旧サーフェスを `Release()` して新デバイス上で再生成するようにした。
- `mods/common/fps_limiter_hook_d3d8.cpp`:
  - `MyPresent8` で `g_d3d8PrePresentCallback` / `g_d3d8PostPresentCallback` を呼び出し、`kPresentThrottle`・`kPresentSkip` を制御。
- `mods/th{06,07,08,09}_replay_autoplay/dllmain.cpp`:
  - `InstallFrameSyncHook(...)` を `InstallFpsLimiterHookD3D8(60.0)` の前に呼び出し、`ScaledSleep` 経由の `FrameSyncSleepMs` と再生開始後の `FrameSyncSetUnthrottled(true)`、`InstallDSoundProbeHook()` を組み込み。

### 3.2 `th07`/`th08`/`th09` のビジーウェイト QPC ループによる 50fps 頭打ち (`stepDiv=32`)
- 初回スモーク時、`th06`（`vpatch_th06.dll` が waitable timer 等を使用、`HookVpatchModule` により QPC=1/Sleep=1/CreateWT=1/SetWT=1/WFSO=1 で即解除）が `5.83x` 出たのに対し、`th07`/`08`/`09` は `50〜52fps` (`< 1.0x`) に張り付いた。
- `objdump` で各実行ファイルのメインループ（`th07.exe` `0x43419b..0x4349e2`, `th08.exe` `0x442028`, `th09.exe` `0x42cc90`）を確認したところ、`Sleep` を挟まず `PeekMessageA + TestCooperativeLevel + QueryPerformanceCounter` を回り続けるビジーウェイト構造だったため、既定 `stepDiv=1024` では1フレームごとに QPC 仮想時計を約 `1024` 回空転して `game_ms≈18〜19ms` を消費していた。
- **`th07`/`08`/`09` に `InstallFrameSyncHook(32)`（`g_stepTicks = g_freq / 60 / 32 = 5208` ticks）を設定**したことで、`th07` が **`6.35x`**、`th09` が **`6.56x`** まで高速化した。

### 3.3 起動画面の VSync キャリブレーションループによる30秒遅延と `th08` ウィンドウ待機タイムアウト (`AdvanceVirtualToFrame`)
- スモーク初期、`th07`/`th08` が起動直後に **`1804` フレーム（約30.2秒）**、`th09` が **`604` フレーム（約10.3秒）** を `unthrottled=0` のまま消費し、`th08` で `WaitForStableWindow(pid, 800, 30000)` が `TIMEOUT (last hwnd=0x00000000)` となった。
- `th09.exe`（`0x42f1d0..0x42f2a2`）を逆アセンブルして原因を特定: `th07`/`08`/`09` は起動時に `Present()` + `timeGetTime()` を1フレーム1回だけ呼んでリフレッシュレートを測定するキャリブレーションループ（500〜699ms 区間を4サンプル集めるまで継続、上限 `th09=600` フレーム / `th07,08=1800` フレーム）を持つ。仮想時計導入直後は `Present()` 自体が `g_vt` を進めないため、1フレームあたり `MyTimeGetTime()` が 1 回呼ぶ `1 * g_stepTicks`（約 `0.52ms`）しか進まず、サンプルが溜まらず上限 `600`/`1800` フレームまで実時間 60Hz で回り切っていた。
- `mods/common/frame_sync_hook.cpp` に `AdvanceVirtualToFrame(LONGLONG frame)` を追加し、`OnPostPresent` 内で `g_vt` を少なくとも `g_vtBase + frame / 60s` まで進めるようにした（D3D9タイトルのように `MySleep`/`MyQPC` で既に 1/60s 以上進む場合は no-op）。これによりキャリブレーションが約 `120` フレーム（約2秒）で 60.0fps を測定して抜け、`WaitForStableWindow` が `th09=3.58s` / `th08=5.21s` / `th07=5.13s` でタイムアウト無しで安定、かつ直後に再作成されていた一時デバイス問題も同時に回避した。`th06` (30s) および `th10` (30s) の回帰スモークも異常なし。

---

## 4. フル尺検証結果（ローカル Xvfb・無負荷逐次）

出力先: `/mnt/cache3/sattori-th0{6,7,8,9}-verify/phase111/full_*/`（各 `PHASE_DIR=phase111 SUMMARY_BIN_FRAMES=7200`）。

| タイトル | リプレイ (難易度等) | フレーム数 (`written=vid=aud`) | 音声端数 | `unknown_plays` / `refill_timeouts` | スコア照合 (`scripts/53`) | 理論尺 (replay-parser) | 動画プレイ長 (差%) | 上限解除平均速度 (動画→実時間) | 全体時間 (動画 / 実時間 / wall) | プレイ区間落ち (`scripts/81`) | ラウドネス (`ebur128`) | HUD (`frame_check.png`) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `th06` | `th6_ud1bws.rpy` (Extra / MarisaB) | `52607` (`OK`) | `0B` | `0 / 0` | `608,183,070` **一致** | `54183f` (`903.0s`) | `51123f` (`852.0s`, `-5.65%`) | **`5.08x`** (`304.8fps`, `167.7s`) | `876.8s` / `192.8s` / `212.42s` | `136` (`1.9%`, `58.88fps`) *※1* | `-7.0 LUFS` | `60.00fps` |
| `th06` | `th6_02.rpy` (Normal / ReimuA) | `89423` (`OK`) | `0B` | `0 / 85` *※2* | `66,329,830` **一致** | `88993f` (`1483.2s`) | `87939f` (`1465.7s`, `-1.18%`) | **`4.47x`** (`268.2fps`, `327.9s`) *※2* | `1490.4s` / `353.0s` / `385.66s` | `112` (`1.6%`, `59.08fps`) *※1* | `-7.7 LUFS` | — |
| `th07` | `th7_07.rpy` (Extra) | `50879` (`OK`) | `0B` | `0 / 0` | `303,766,040` **一致** | `50812f` (`846.9s`) | `49802f` (`830.0s`, `-1.99%`) | **`5.37x`** (`322.2fps`, `154.6s`) | `848.0s` / `173.1s` / `192.57s` | `0` (`0.0%`, `60.01fps`) | `-5.5 LUFS` | `60.00fps` |
| `th07` | `th7_09.rpy` (Hard) | `125631` (`OK`) | `0B` | `0 / 0` | `430,405,880` **一致** | `130515f` (`2175.2s`) | `124550f` (`2075.8s`, `-4.57%`) | **`5.74x`** (`344.1fps`, `361.9s`) | `2093.8s` / `380.5s` / `421.46s` | `2` (`0.0%`, `59.99fps`) | `-6.1 LUFS` | — |
| `th08` | `th8_01.rpy` (Extra) | `47575` (`OK`) | `0B` | `0 / 0` | `879,440,560` **一致** | `46501f` (`775.0s`) | `46447f` (`774.1s`, `-0.12%`) | **`5.29x`** (`317.1fps`, `146.5s`) | `792.9s` / `165.4s` / `183.07s` | `0` (`0.0%`, `60.01fps`) | `-7.6 LUFS` | `60.00fps` |
| `th08` | `th8_06.rpy` (Normal) | `118111` (`OK`) | `0B` | `0 / 0` | `1,196,970,600` **一致** | `118791f` (`1979.8s`) | `116982f` (`1949.7s`, `-1.52%`) | **`5.46x`** (`327.4fps`, `357.3s`) | `1968.5s` / `376.2s` / `412.35s` | `0` (`0.0%`, `60.01fps`) | `-8.0 LUFS` | — |
| `th09` | `th9_07.rpy` (Lunatic Story / Aya) | `64911` (`OK`) | `0B` | `0 / 0` | *※3* 残機遷移確認 | `65074f` (`1084.6s`) | `63957f` (`1066.0s`, `-1.72%`) | **`4.92x`** (`294.9fps`, `216.8s`) | `1081.8s` / `232.9s` / `257.08s` | `42` (`0.6%`, `59.66fps`) *※1* | `-8.2 LUFS` | `60.00fps` |
| `th09` | `th9_ud5615.rpy` (Lunatic Match / Reimu) | `10063` (`OK`) | `0B` | `0 / 0` | *※3* `lives:10→5→1` | `8848f` (`147.5s`) | `9107f` (`151.8s`, `+2.93%`) *※4* | **`4.57x`** (`274.1fps`, `33.2s`) | `167.7s` / `49.4s` / `58.27s` | `45` (`0.7%`, `59.58fps`) *※1* | `-8.8 LUFS` | — |

- ***※1 `th06`/`th09` の `scripts/81` 落ちフレーム値について***:
  `--list-bursts` および参照 `phase89_speedup/raw/th06_1x.mp4`（同一区間で `132フレーム / 1.8% / 58.91fps`）、`th09_1x.mp4`（`38フレーム / 0.7% / 59.60fps`）との突き合わせにより、`th06`（`103.07〜105.35s` = 1面クリア暗転、`155.42〜162.37s` = 2面遷移）および `th09`（試合間・決着後リザルト `160.92〜163.92s`）の**ゲーム演出上の静止画/暗転**と完全一致することを確認した（フェーズ89参照の `+7.45s` 位置で全バーストが一致）。実際の描画落ちは0。
- ***※2 `th6_02` の `refill_timeouts=85` の原因（ローカル環境固有の WAV ファイル破損）***:
  `full_th6_02/th06_autoplay.log` で Stage 2 ボス曲（`buffer=63`、`mixed_frame=15454` で開始）が46秒経過した `frame=18214` から Stage 3 BGM（`buffer=64`, `frame=20825`）まで `refill wait timeout` が 85 回発生し、区間2だけ `113.6fps (1.89x)` に低下した。`games/th06/bgm/*.wav` の実ファイルサイズと RIFF ヘッダ長を全曲照合した結果、`th06_05.wav`（チルノ戦BGM）だけが **実サイズ `8,454,144B` に対し RIFF 期待長 `15,859,834B`（約48秒地点で途中切断）** であり、他の16曲はすべて完全一致だった。`東方紅魔郷.exe`（`0x43b560` / `0x43be70` / `0x43c080`）を確認したところ、ファイル末尾を超えて `mmioAdvance` が失敗するため `Unlock()` が呼ばれなくなる挙動であり、実際の音量・波形（301〜340s 区間で `th06_1x` `-9.8dB / lag2s_ncc=0.8087` に対し `full_th6_02` `-9.8dB / lag2s_ncc=0.6920`）でも確認した。500ms×85≒`42.5s` のタイムアウト待ちを除くと `th6_02` の実質速度は **`~5.14x`（~308fps）** で `th6_ud1bws` (`5.08x`) と整合する。なお `frame_sync_audio` 自体の不具合ではない。
- ***※3 `th09` スコア***: `th09` の `ScoreMonitorConfig` は `scoreWidth=0`（P1 残機のみ監視）のため、リプレイ終端までの残機推移とテンプレート終端一致で完走を確認。
- ***※4 `th9_ud5615` 再生長***: 約2.5分と短尺のため、試合決着後の結果画面〜リプレイ選択画面戻り待ち（約4.3秒、上記 `160.9〜163.9s` の静止画面区間）の割合が相対的に `+2.93%` として現れた（9戦ある長尺 `th9_07` では `-1.72%`）。

### 1フレーム所要時間内訳 (`scripts/105_frame_sync_summary.py`)

| タイトル (ラン) | `summary.txt` 解除中平均 | `game` ms | `readback` ms | `write` ms | `present` ms | 合計 ms | `audio` ms |
|---|---|---|---|---|---|---|---|
| `th06` (`full_th6_ud1bws`) | `297.0fps (4.95x)` | `0.48` | `1.87` | `0.55` | `0.09` | `2.98` | `0.37` |
| `th06` (`full_th6_02`) | `265.1fps (4.42x)` | `0.43` | `1.85` | `0.50` | `0.05` | `2.83` | `0.92` |
| `th07` (`full_th7_07`) | `308.0fps (5.13x)` | `1.25` | `0.62` | `1.11` | `0.14` | `3.12` | `0.11` |
| `th07` (`full_th7_09`) | `337.4fps (5.62x)` | `0.73` | `0.72` | `1.32` | `0.06` | `2.83` | `0.12` |
| `th08` (`full_th8_01`) | `301.7fps (5.03x)` | `0.77` | `1.08` | `1.15` | `0.17` | `3.17` | `0.13` |
| `th08` (`full_th8_06`) | `320.5fps (5.34x)` | `0.73` | `0.92` | `1.26` | `0.07` | `2.98` | `0.13` |
| `th09` (`full_th9_07`) | `288.4fps (4.81x)` | `0.72` | `1.81` | `0.68` | `0.08` | `3.29` | `0.16` |
| `th09` (`full_th9_ud5615`) | `235.2fps (3.92x)` | `0.56` | `2.34` | `0.58` | `0.59` | `4.07` | `0.17` |

---

## 5. 既存参照動画とのタイムライン比較・目視確認

`scripts/87_compare_timeline.py` でフェーズ89等倍参照動画（`phase89_speedup/raw/th0*_1x*.mp4`、同期マーカー導入前の PulseAudio 直接録音）と比較した結果:

- **`th06` (`th6_02`)**: `60s / 270s / 600s / 1200s` で `video_off = +7.450s → +6.850s → +6.183s → +5.300s`、`av_delta = +235.9ms / +174.4ms / +201.1ms / +167.8ms`（`300s` 付近はBGM周回重複と `th06_05.wav` 破損で別周期と一時マッチ）。
- **`th07` (`th7_07`)**: `60s / 300s / 600s` すべてで `video_off = +11.867s` 完全に一定、`av_delta = +217.0ms / +203.7ms / +303.7ms`。
- **`th08` (`th8_01`)**: `60s / 300s / 600s` で `video_off = +14.683s / +14.750s / +14.783s`、`av_delta = +210.2ms / +143.7ms / +210.4ms`。
- **`th09` (`th9_ud5615`)**: `30s / 60s / 90s / 120s` で `video_off = +10.333s → +10.250s`（`-83ms`）、`audio_off = +10.6134s`（`+0.28〜+0.36s` の定数オフセットはフェーズ89参照側の PulseAudio 出力遅延）。
- **目視確認**: 4タイトルすべてで中盤 `t=120s` の `frame_check.png`（`th06` 恋符マスタースパーク、`th07` 橙「鬼符「青鬼赤鬼」」、`th08` 慧音 Extra、`th09` Stage 2）を直接確認し、正常な発色・弾幕描画および右下の `60.00fps` HUD 表示を確認した。
