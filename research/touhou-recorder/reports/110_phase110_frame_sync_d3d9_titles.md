# フェーズ110: D3D9 5タイトル (`th10`, `th11`, `th128`, `th13`, `th20`) へのフレーム同期キャプチャ展開（2026-11-20 追補: `th14` 追加）

## 1. 概要と結論

フェーズ105〜109で `th12` / `th15` に実装・検証したフレーム同期キャプチャ（`--frame-sync`: バックバッファ読み出し＋仮想時計＋DirectSound仮想音声デバイス）を、残りのD3D9＋DirectSound8系5タイトル（`th10`, `th11`, `th128`, `th13`, `th20`）に横展開し、ローカル（Xvfb + wined3d + llvmpipe、CPU描画、無負荷逐次実行）でスモーク検証・フル尺9本・スレッド数スケーリング4本を実施した。

*(2026-11-20 追補)* 当初対象から漏れていた同じく D3D9＋DirectSound8 系の `th14`（東方輝針城 ver1.00b・非Steam版、`1280x960`）についても同様に対応・検証を実施し、スモーク1本・フル尺2本・スレッド数スケーリング2本を追加した（計6タイトル・フル尺11本・スケーリング6本）。

- **全6タイトル（追補含む）・全11本（Extra / Hard / Lunatic）が試行1回・完走・スコア完全一致で合格**。
- `frames_written == video_frames == audio_frames`（音声端数 `0` バイト）、`unknown_plays = 0`（`th14` も `refill_timeouts = 0`）。
- プレイ区間落ちフレーム率は全11本で **`0.0〜0.1%`（実効 `59.92〜60.00fps`）**（`th14` は2本とも **`0.0%` / `60.00fps`**）、理論尺超過は **`-0.46% 〜 +0.40%`**（上限 `+1.0%` 以内、`th14` は `-0.32% 〜 +0.19%`）。
- ローカル（Ryzen 7 5700X / 16スレッド）での上限解除平均速度:
  - `th10`: **4.81〜5.42倍速** (`288.6〜325.3fps`)
  - `th11`: **3.45〜3.46倍速** (`207.0〜207.8fps`)
  - `th128`: **2.78〜2.95倍速** (`166.6〜176.7fps`)
  - `th13`: **2.91〜3.03倍速** (`174.6〜181.7fps`)、8スレッド **`2.62x`** / 4スレッド **`1.45x`**
  - `th14` *(追補)*: Extra **`1.17倍速`** (`70.1fps`) / Lunatic **`1.38倍速`** (`83.0fps`)、8スレッド **`0.92x`** / 4スレッド **`0.48x`**
  - `th20`: **1.29倍速** (`77.6fps`)、8スレッド **`1.10x`** / 4スレッド **`0.60x`**

---

## 2. 実装した変更点

### 2.1 `vpatch_th10.dll` IATフック＋`CalcFPS = 0`（`th10`）
- `mods/common/frame_sync_hook.cpp`: `HookIATEntry` をモジュール汎用版 `HookModuleIATEntry` に整理し、`HookVpatchModule(const char* modName)` を追加して `InstallFrameSyncHook()` から `"vpatch_th06.dll"` / `"vpatch_th10.dll"` の `KERNEL32.dll` IAT（`QueryPerformanceCounter`, `Sleep`, `CreateWaitableTimerA`, `SetWaitableTimer`, `WaitForSingleObject`）をフックするようにした。`vpatch` が `SleepType = 1` で使う待機タイマは `TrackVpatchTimer` / `IsTrackedVpatchTimer` で追跡し、仮想時計有効時に実時間待機をスキップする。
  - `th10` 実行時ログ: `FrameSync: hooked vpatch IAT (vpatch_th10.dll) QPC=1 Sleep=1 CreateWT=1 SetWT=1 WFSO=1`。これにより `th10` は 60fps 固定にならず `4.81〜5.42x` で動作した。
- `recorder/pipeline.py`（`_launch_game`）・`recorder/instance.py`（`prepare_instance` / `_apply_vpatch_game_fps`）: `frame_sync=options.frame_sync` を渡し、`--frame-sync` 時は `vpatch.ini` の `CalcFPS` を `0` に設定するようにした（`vpatch` 独自の実時間タイマーによるFPS表示異常を防ぎ、ゲーム側の仮想時計ベースで `60.0fps` 表示に揃える）。

### 2.2 `SYNC_MARKER_TRIGGER` 残置による `unknown_plays=1` 解消
- 初期スモーク実行で全5タイトルに `unknown_plays=1` が発生した。原因は、通常録画時と共通の `config.build_env()` が `SYNC_MARKER_TRIGGER` を環境変数に設定し、`mods/common/dsound_hook.cpp` の `ArmSyncMarker()` が `frame_sync_audio` 非認識の `SyncMarker` バッファ再生を起動していたため。
- `recorder/framesync.py` の `attempt_recording_frame_sync` で `env.pop("SYNC_MARKER_TRIGGER", None)` を実施し、`mods/common/dsound_hook.cpp` の `ArmSyncMarker()` でも `FRAME_SYNC_AUDIO` 設定時は即 `return` するよう二重防御した。以降の全9本・スケーリング4本で **`unknown_plays=0`** を確認。

### 2.3 スコア照合スクリプト・各MOD・検証ランナー対応
- `scripts/53_verify_replay_score.py`: `GAME_MULTIPLIERS` に `"th13": 10, "th14": 10, "th15": 10` を追加。
- `scripts/105_run_frame_sync.sh`: `${PHASE_DIR:-phase105}` で出力先ディレクトリを切り替えられるよう変更。
- `mods/{th10,th11,th128,th13,th20}_replay_autoplay/dllmain.cpp`:
  - `InstallFrameSyncHook()` を `InstallFpsLimiterHook(60.0)` / `InstallDSoundHook(1.0)` より前に追加。
  - `AutoPlayThread` の待機を `ScaledSleep`（`FrameSyncActive()` 時は `FrameSyncSleepMs()`）化し、タイトル画面初期待機を `8000ms`（`th10`/`th11`/`th128`/`th13`、th20は既存設定に準拠）へ調整、操作完了後・`sequence complete` 直前に `FrameSyncSetUnthrottled(true)` を挿入。`InstallDSoundProbeHook()` も併設（`DSOUND_PROBE` 未設定時は無動作）。
  - ビルド: `for g in th10 th11 th128 th13 th20; do bash mods/common/build_mingw.sh "$g"; done`。
- `mods/th14_replay_autoplay/dllmain.cpp` *(2026-11-20 追補)*:
  - 同様に `InstallFrameSyncHook()`（`InstallSpeedHackHook()` 直後・`InstallFpsLimiterHook(60.0)` より前）、`InstallDSoundProbeHook()`、`ScaledSleep` の `FrameSyncSleepMs()` 分岐、`AutoPlayThread` 末尾の `FrameSyncSetUnthrottled(true)` を追加（タイトル画面初期待機は既存 `10000ms` のまま）。`bash mods/common/build_mingw.sh th14` でビルドし、60秒スモーク（`smoke_th14_08`, `th14_08.rpy`: `4615`f 一致、端数 `0B`、`unknown_plays=0 / refill_timeouts=0`、`1.38x / 82.7fps`、`frame30s.png` 目視正常）を確認。

---

## 3. フル尺検証結果（ローカル Xvfb・無負荷逐次）

実行コマンド例:
```bash
export PATH="$HOME/.asdf/shims:$PATH"
PHASE_DIR=phase110 scripts/105_run_frame_sync.sh th10 full_extra_th10_03 th10_03.rpy
# th128 / th20 は EXTRA_ARGS="--thprac" を付与
```

| タイトル | リプレイ | 条件 | フレーム数 (`written=vid=aud`) | 音声端数 | `unknown_plays` / `refill_timeouts` | スコア照合 (`scripts/53`) | 理論尺 (replay-parser) | 動画プレイ長 (差%) | 上限解除平均速度 (動画→実時間) | 全体時間 (動画 / 実時間) | プレイ区間落ち (`scripts/81`) | ラウドネス (`ebur128`) | HUD (`frame_check.png`) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `th10` | `th10_03.rpy` (Extra) | 通常 | `50087` (`OK`) | `0` | `0 / 0` | `203,442,620` 一致 | `813.82s` | `817.05s` (`+0.40%`) | **`5.42x`** (`325.3fps`) | `834.8s` / `166.8s` | `7` (`0.0%`, `59.99fps`) | `-6.5 LUFS` (参照 `-6.4`) | `60.0fps` |
| `th10` | `th10_25.rpy` (Lunatic) | 通常 | `87879` (`OK`) | `0` | `0 / 0` | `219,280,690` 一致 | `1444.22s` | `1446.84s` (`+0.18%`) | **`4.81x`** (`288.6fps`) | `1464.7s` / `316.9s` | `25` (`0.0%`, `59.98fps`) | `-7.3 LUFS` | `60.0fps` |
| `th11` | `th11_04.rpy` (Extra) | 通常 | `63031` (`OK`) | `0` | `0 / 0` | `478,484,390` 一致 | `1018.83s` | `1018.95s` (`+0.01%`) | **`3.46x`** (`207.8fps`) | `1050.5s` / `314.2s` | `0` (`0.0%`, `60.00fps`) | `-6.8 LUFS` | `60.0fps` |
| `th11` | `th11_03.rpy` (Hard) | 通常 | `90799` (`OK`) | `0` | `0 / 0` | `182,237,970` 一致 | `1480.82s` | `1482.86s` (`+0.14%`) | **`3.45x`** (`207.0fps`) | `1513.3s` / `449.1s` | `7` (`0.0%`, `60.00fps`) | `-6.8 LUFS` | `60.0fps` |
| `th128` | `th128_extra01.rpy` (Extra) | `--thprac` | `80855` (`OK`) | `0` | `0 / 0` | `100,845,160` 一致 | `1321.77s` | `1316.88s` (`-0.37%`) | **`2.78x`** (`166.6fps`) | `1347.6s` / `495.2s` | `0` (`0.0%`, `60.00fps`) | `-4.8 LUFS` | `60.0fps` |
| `th128` | `th128_ud0000.rpy` (Hard) | `--thprac` | `50647` (`OK`) | `0` | `0 / 0` | `22,666,770` 一致 | `816.67s` | `812.94s` (`-0.46%`) | **`2.95x`** (`176.7fps`) | `844.1s` / `296.6s` | `0` (`0.0%`, `60.00fps`) | `-5.4 LUFS` | `60.0fps` |
| `th13` | `th13_06.rpy` (Extra) | 通常 | `47967` (`OK`) | `0` | `0 / 0` | `117,168,790` 一致 | `765.10s` | `767.21s` (`+0.28%`) | **`2.91x`** (`174.6fps`) | `799.5s` / `285.3s` | `0` (`0.0%`, `60.00fps`) | `-7.3 LUFS` (参照 `-7.2`) | `60.0fps` |
| `th13` | `th13_02.rpy` (Hard) | 通常 | `105287` (`OK`) | `0` | `0 / 0` | `257,269,690` 一致 | `1728.55s` | `1722.91s` (`-0.33%`) | **`3.03x`** (`181.7fps`) | `1754.8s` / `590.0s` | `141` (`0.1%`, `59.92fps`) | `-7.6 LUFS` (参照 `-7.5`) | `60.1fps` |
| `th14` *(追補)* | `th14_08.rpy` (Extra) | 通常 | `48063` (`OK`) | `0` | `0 / 0` | `160,711,180` 一致 | `767.37s` | `768.85s` (`+0.19%`) | **`1.17x`** (`70.1fps`) | `801.0s` / `688.2s` | `0` (`0.0%`, `60.00fps`) | `-7.6 LUFS` (参照 `-7.5`) | `60.0fps` |
| `th14` *(追補)* | `th14_22.rpy` (Lunatic) | 通常 | `91951` (`OK`) | `0` | `0 / 0` | `409,380,990` 一致 | `1505.60s` | `1500.85s` (`-0.32%`) | **`1.38x`** (`83.0fps`) | `1532.5s` / `1112.7s` | `0` (`0.0%`, `60.00fps`) | `-7.4 LUFS` (参照 `-7.3`) | `60.0fps` |
| `th20` | `th20_01.rpy` (Hard) | `--thprac` | `99791` (`OK`) | `0` | `0 / 13` | `481,237,400` 一致 | `1633.47s` | `1630.89s` (`-0.16%`) | **`1.29x`** (`77.6fps`) | `1663.2s` / `1290.6s` | `11` (`0.0%`, `59.99fps`) | `-9.2 LUFS` (参照 `-9.1`) | `60.0fps` |

※ `th13_02` の落ち141フレームは `scripts/81_analyze_stutter_periodicity.py --list-bursts` により `487.72〜489.80s`・`788.65〜791.12s`・`1077.25〜1077.93s`・`1380.72〜1383.15s` の4区間（各ステージ遷移の暗転・静止画）にのみ集中していることを確認。

### 1フレーム所要時間内訳 (`scripts/105_frame_sync_summary.py`)

| タイトル (ラン) | 解除中平均 (`summary.txt`) | `game` ms | `readback` ms | `write` ms | `present` ms | 合計 ms | `audio` ms (Present前・別計上) |
|---|---|---|---|---|---|---|---|
| `th10` (`full_extra_th10_03`) | `316.1fps (5.27x)` | `0.51` | `1.68` | `0.74` | `0.09` | `3.03` | `0.12` |
| `th10` (`full_lunatic_th10_25`) | `284.5fps (4.74x)` | `0.61` | `1.75` | `0.96` | `0.05` | `3.38` | `0.12` |
| `th11` (`full_extra_th11_04`) | `205.2fps (3.42x)` | `2.79` | `0.50` | `0.99` | `0.06` | `4.35` | `0.51` |
| `th11` (`full_hard_th11_03`) | `205.7fps (3.43x)` | `2.90` | `0.41` | `0.98` | `0.03` | `4.32` | `0.53` |
| `th128` (`full_extra01`) | `165.4fps (2.76x)` | `3.52` | `0.96` | `0.98` | `0.04` | `5.50` | `0.53` |
| `th128` (`full_hard_ud0000`) | `174.6fps (2.91x)` | `3.24` | `0.83` | `1.01` | `0.06` | `5.15` | `0.57` |
| `th13` (`full_extra_th13_06`) | `172.0fps (2.87x)` | `3.44` | `1.06` | `1.08` | `0.09` | `5.68` | `0.12` |
| `th13` (`full_hard_th13_02`) | `180.5fps (3.01x)` | `3.29` | `1.23` | `0.82` | `0.04` | `5.38` | `0.14` |
| `th14` (`full_extra_th14_08`) *(追補)* | `70.0fps (1.17x)` | `1.48` | `9.13` | `3.38` | `0.10` | `14.09` | `0.18` |
| `th14` (`full_lunatic_th14_22`) *(追補)* | `82.8fps (1.38x)` | `1.31` | `7.49` | `3.02` | `0.05` | `11.88` | `0.18` |
| `th20` (`full_hard_th20_01`) | `77.5fps (1.29x)` | `6.50` | `2.11` | `3.57` | `0.04` | `12.21` | `0.67` |

*(注: `summary.txt` は600フレーム窓単位、`run.log` の上限解除後は `FrameSync: unthrottled=1` から `stopCapture` までの厳密区間)*

---

## 4. `th20` の `refill_timeouts=13` 原因調査（音欠け無し）

- `DSOUND_PROBE=1`（`p110_probe`）および `games/th20/th20.exe` の逆アセンブル（`0x45a620〜0x45a697`）により原因を特定。
- `th20` の BGM スレッドは `705,600` バイト（`4.0s` @ 44100Hz/16bit/2ch）の循環バッファを 16 等分（`44,100` バイト = `0.25s` ごと、`first=44099` 〜 `last=705599`）して通知を待つ。
- `th20.exe` `0x45a631〜0x45a67c` は `GetCurrentPosition` の戻り `write` と前回書き込み位置 `last_written` (`0x9c(%edx)`) の差から未書き込み量が `chunk=44100` 未満かどうか判定する際、周回境界付近（`last_written = 705600` 折り返し前の16番目通知 `705599` 等で `write < 44100` のとき、`0x45a648〜0x45a654` 等の比較分岐）で1トラックあたり1回だけ補充を意図的にスキップし、次の通知（`44099` 付近）でまとめて2チャンク補充する実装になっている（実 `dsound` のプローブでも同一挙動）。
- スキップ時の最大待ち（`RefillTimeout` 0.5s 相当のハンドシェイク待機）がトラック切替ごと（計13トラック = 13回、60sベンチでは2回）記録されたが、バッファ残量には `3.5s` 以上の余裕があり音飛び・欠損は一切発生しない。参照動画とのラウドネスも `-9.2 LUFS` vs `-9.1 LUFS` で一致。

---

## 5. 既存参照動画とのタイムライン比較 (`scripts/87_compare_timeline.py`)

`export NUMPY_MADVISE_HUGEPAGE=0` 下で従来方式の既存検証動画と比較した:

- **`th10` Extra** (`102/area_full.mp4` `829.57s` vs Phase 110 `834.78s`): `200s..750s` で `audio_off` は `+3.986s〜+3.860s`、`video_off` は `+3.950s` (`20s`) 〜 `+3.417s` (`750s`)。
- **`th13` Extra (`th13_06`)** (`full_th13_06.mp4` `802.48s` vs Phase 110 `799.45s`): **`audio_off` が `200s` `+0.5910s`、`400s` `+0.5914s`、`600s` `+0.5869s`、`720s` `+0.5884s` と全区間で ±4.5ms 以内に固定**している一方、通常録画の参照側映像が `20s→720s` で `+0.483s→-1.017s` と約1.5秒遅延していた（フレーム同期側は `theo=765.10s` に対し `play=767.21s` と正確）。
- **`th13` Hard (`th13_02`)** (`full_th13_02.mp4` `1757.38s` vs Phase 110 `1754.78s`): `400s..1600s` で `av_delta` は `+37.2ms〜+113.9ms`。
- **`th20` Hard (`th20_01`)** (`phase89_speedup/raw/th20_1x.mp4` `1665.18s` vs Phase 110 `1663.18s`): 従来1x CPU参照側が終盤にかけて遅延し、`1550s` で `video_off=-1.767s / audio_off=-1.085s` の差となった（フレーム同期側は `theo=1633.47s` に対し `play=1630.89s`, `-0.16%`）。
- **`th14` Extra (`th14_08`)** *(2026-11-20 追補)* (`aws2/g6f_x1_extra.mp4` `800.48s` vs Phase 110 `801.05s`): **`audio_off` が `200s` `+0.4545s`、`400s` `+0.4464s`、`600s` `+0.4464s`、`720s` `+0.4464s` と固定**している一方、参照側 GPU 1x (`FpsMonitor 59.9Hz`) の映像が `-0.167%/s` 相当で遅れて `video_off` が `60s +0.650s → 720s -0.433s`（`MAD 0.31〜5.80`）へシフトした（`restored/g6f_2x_extra_restored.mp4` `FpsMonitor 119.7Hz` 比較でも `400s〜720s` の `audio_off = -0.1100s` 固定・`video_off +0.233s→-1.217s` で同一傾向）。これは上記 `th13` Extra と同じく、通常録画の映像（`59.9Hz` / `119.7Hz`）に対し実時間 DirectSound 上で連続再生されるボス戦1曲（`buffer 80`：`mixed_frame=15465..46996` [257.75s..783.27s]）の BGM が実時間基準で先行していたためであり、フレーム同期側ではクリア遷移（`782.5s`）から BGM 停止（`783.3s`）まで映像・音声が1フレーム=735サンプルで固定同期していることを確認した（`g6f_x1_extra` 側も `783.1s→783.8s` で停止）。
- **`th14` Lunatic (`th14_22`)** *(2026-11-20 追補)* (`aws2/g6f_x1_lunatic.mp4` `1533.05s` vs Phase 110 `1532.52s`): 参照側 `59.9Hz` 遅延により `video_off` が `60s +0.667s → 300s +0.317s → 600s -0.183s → 900s -0.717s → 1200s -1.200s → 1450s -1.600s` へ単調シフトし、6面分のステージ／ボス BGM 切替で各面の再生開始位置が映像へ追随する `audio_off` も `+0.7969s → +0.3235s → -0.1317s → -0.5832s → -1.0732s → -1.1498s`（`60〜1200s` の `av_delta = +6.8ms〜+133.5ms`、終盤 `1450s` `+450.2ms`）と推移した（フレーム同期側のプレイ長 `1500.85s` vs 理論 `1505.60s`, `-0.32%`）。

---

## 6. スレッド数スケーリング検証（`taskset` + `LP_NUM_THREADS`, 60秒ベンチ）

負荷の重い3タイトルについて、`taskset -c` と `LP_NUM_THREADS` で vCPU 数を絞って計測した:

```bash
# 8スレッド相当 (4コア8スレッド): taskset -c 0-3,8-11, LP_NUM_THREADS=8
# 4スレッド相当 (2コア4スレッド): taskset -c 0-1,8-9, LP_NUM_THREADS=4
```

| タイトル | テスト | 16スレッド (フル尺) | 8スレッド (`0-3,8-11`, 60s) | 4スレッド (`0-1,8-9`, 60s) | `written=vid=aud` / 端数0 |
|---|---|---|---|---|---|
| `th13` | Extra (`th13_06`) | **`2.91x`** (`174.6fps`) | **`2.62x`** (`157.3fps`, `summary 2.31x`) | **`1.45x`** (`86.8fps`, `summary 1.43x`) | 全一致 (`4631` / `4615`, 0B) |
| `th14` *(追補)* | Extra (`th14_08`) | **`1.17x`** (`70.1fps`) | **`0.92x`** (`55.2fps`, `summary 0.92x`) | **`0.48x`** (`28.8fps`, `summary 0.49x`) | 全一致 (`4623` / `4607`, 0B) |
| `th20` | Hard (`th20_01 --thprac`) | **`1.29x`** (`77.6fps`) | **`1.10x`** (`66.1fps`, `summary 1.06x`) | **`0.60x`** (`35.9fps`, `summary 0.57x`) | 全一致 (`4599` / `4591`, 0B) |

- `th13` は4スレッド相当でも約 `1.45x` を維持し、8スレッドでは `2.62x` へ伸びる。
- `th14`（`1280x960` CPU描画）は16スレッドで `1.17x`（Lunatic `1.38x`）、8スレッド相当で `0.92x`（保持率 79%）、4スレッドで `0.48x`（保持率 41%）となり、いずれの条件でもフレーム・音声一致かつ `unknown_plays=0 / refill_timeouts=0` で決定的に完走する。
- `th20`（`1280x960` CPU描画）は8スレッド相当で `1.10x`（等倍以上）、4スレッドでも `0.60x` ながらフレーム落ち `0`・破綻なしで決定的に完走する。
