# フェーズ109: フレーム同期キャプチャの負荷耐性(決定性)・クラウド実機検証・コスト評価

日付: 2026-11-19

## 結論

フェーズ108までで完成したフレーム同期キャプチャ（`--frame-sync`、映像FIFO + 仮想音声デバイス `mods/common/frame_sync_audio`）について、本番サービス（`../sattori`）導入に向けた3つの検証課題（①同居プロセス負荷下の決定性、②AWS Spot クラウド環境での動作・品質、③クラウド環境でのコスト削減効果）を `th12`（640x480）および `th15`（1280x960）のフル尺リプレイで検証した。

- **調査課題1（同居プロセス負荷下の決定性）**: ローカル2タイトル同時並列（`1a_parallel`）、ローカル16ワーカー CPU 100%飽和（`1b_load16`: `th15` 平均 `6.5fps = 0.11倍速`、`th12` 平均 `11.5fps = 0.19倍速`）、クラウド `c7i.2xlarge` 8ワーカー CPU 100%飽和（`load8`: `th15` 平均 `18.2fps = 0.30倍速`、`th12` 平均 `35.9fps = 0.60倍速`）のすべてにおいて、無負荷基準動画と比較して **映像フレームドリフト `[0, 0, 0]f`、音声サンプルドリフト `[0, 0, 0]samp`、A/V相対ズレ `0samp (0.0ms)`、BGM補充タイムアウト `refill_timeouts=0`、未把握再生 `unknown_plays=0`、記録スコア完全一致** を達成した。処理速度が等倍の約1/9（0.11倍速）まで落ち込んでも、出力品質は負荷の影響を一切受けず決定的に一致する。なお、高負荷環境でもメニュー入力が破綻しないよう、`FrameSyncSleepMs()` と ffmpeg `-nostdin` を導入して対策した。
- **調査課題2（クラウド環境での動作・品質）**: AWS EC2 Spot の CPU 描画（`c7i.4xlarge`, `c7i.2xlarge`, `m7i.xlarge`, `eu-south-2`）および GPU 描画+NVENC（`g6f.xlarge` NVIDIA L4-3Q, `us-west-2`）で実施したフル尺クラウド録画計19本（無負荷17本＋CPU飽和負荷2本、およびローカルフル尺4本）**すべてが試行1回目で完走**し、映像フレーム数＝音声サンプル数（端数0バイト）・記録スコア完全一致・基準動画との `drift=[0,0,0]` / `A/V差=0.0ms` を満たした。プレイ区間の落ちフレーム率（`scripts/81_analyze_stutter_periodicity.py`）は、`th15` Extra が全7セルで **0 (0.0%, 実効 60.00fps)**、`th15` Hard が **2〜4 (0.0%, 60.00fps)**、`th12` Hard が **1〜2 (0.0%, 60.00fps)**、`th12` Extra が **40〜78 (0.1〜0.2%, 59.89〜59.94fps)** と全セルで基準（≤1.5%）を大きく上回った。
  - なお、`th12` の初回 `c7i.4xlarge` 検証で発覚した **AWS `Xvfb` 上での 60.0fps 頭打ち** は、`th12.cfg` オフセット `0x23=2` 時に `th12.exe`（`0x4501e0`）が呼ぶ `IDirect3DDevice9::GetRasterStatus`（`vtable[19]`）に起因することを特定し、`MyGetRasterStatus` フック追加により `c7i.4xlarge` で **2.31〜2.33倍速**、`c7i.2xlarge` で **1.76倍速**、`m7i.xlarge` で **1.10〜1.13倍速** へ解放された。
- **調査課題3（クラウドコスト比較・リプレイ尺1時間あたり）**: 課金時間＝`180s + 録画実時間 + 配信版変換実時間`、単価＝`Spot単価 + $0.0086/h`（EBS+IPv4、`../sattori/docs/reports/2026-11-08-recommended-speed-fallback-order-and-cost.md` と同式。ただし Phase 109 の変換時間は実機 `109_bench_convert.py` の実測比を使用）で評価した結果、以下を確認した。
  - **`th12`（CPU 描画）**: `c7i.2xlarge` で **1.76倍速 / `$0.058〜0.059`/時**（2026-11-08単価 `$0.0421/h` 換算で **`$0.044`/時**）となり、従来の CPU 等倍（同インスタンス `1.270h / $0.087`/時、かつ落ち3.1〜3.3%で品質基準外）より **費用・時間を約32%削減しつつ品質問題を完全に解消** した（`eu-south-2` の GPU 2倍速 `$0.073〜0.123`/時より安価で G 系クォータも消費しない）。さらに従来は処理落ちで使えなかった 4 vCPU 帯（`m7i.xlarge`）も **1.10〜1.13倍速 / `$0.053〜0.054`/時**（品質落ち 0.0〜0.2%）で実用解禁となった。`c7i.4xlarge` は **2.31〜2.33倍速**（課金時間 `0.65h`、最短 `38.6〜39.3分` / 尺1時間、`eu-south-2b` `$0.0982/h` で **`$0.069〜0.070`/時**）。
  - **`th15`（CPU / 4vCPU GPU 描画）**: `c7i.4xlarge`（CPU）で **Extra 1.20倍速 / `$0.135`/時**、**Hard 1.48倍速 / `$0.118`/時** となり、従来の CPU 低速録画（Extra 1/3倍速 `3.360h / $0.359`/時、Hard 1/2倍速 `2.330h / $0.249`/時）と比べて **時間・費用を Extra で62.5%削減（`$0.359 → $0.135`）、Hard で52.7%削減（`$0.249 → $0.118`）** し、1/3倍速の120分実時間上限（尺39分打ち切り）も解消された。また `c7i.2xlarge`（`0.67〜0.80倍速`、**`$0.134〜0.151`/時**、落ち0.0%）や 4 vCPU GPU の `g6f.xlarge`（`1.00倍速`、**`us-west-2c` `$0.112`/時・`eu-north-1b` `$0.098`/時**、落ち0.0%）も本番候補として利用可能になった。一方、4 vCPU CPU の `m7i.xlarge` は `th15` Extra が `0.35倍速`（変換比 `1.2711`）で計 `4.17h / $0.167`/時と逆に高く遅くなるため `th15` には不適。

---

## 1. Phase 109 で実装した修正・検証ツール

### 1.1 高負荷環境対応（コミット `d0fb656`）

極端な CPU 飽和下でもリプレイ再生操作がタイムアウト・誤入力しないよう以下を導入した。

- **Present カウント基準待機 `FrameSyncSleepMs()`**（`mods/common/frame_sync_hook.cpp`, `mods/common/frame_sync_hook.h`）:
  - `--frame-sync` 有効時、従来の実時間 `Sleep(ms)` ではなく `g_presentCount32`（60fps換算で `((ms * 60 + 999) / 1000)` フレーム、300秒の上限付き）とロードスレッド完了（`CountLiveTracked(RealNow()) == 0`）を待機する `FrameSyncSleepMs(DWORD ms)` を実装し、`mods/th12_replay_autoplay/dllmain.cpp` および `mods/th15_replay_autoplay/dllmain.cpp` の `ScaledSleep()` から呼び出すように変更した。あわせてタイトルアニメーション待機 `titleWaitMs` をそれぞれ `8000` / `11500`（仮想ms）へ延長した。
- **DirectInput 待機延長**（`mods/common/dinput_hook.cpp`）:
  - `WaitFrames()` で `FrameSyncActive()` 時は `timeoutMs` の下限を `60000`ms に延長した。
- **パイプラインの対話禁止・タイムアウト調整・NVENC 対応**（`recorder/framesync.py`, `scripts/measure_duplicate_frame_rate.sh`）:
  - `ffmpeg` / `ffprobe` 呼び出しに `-nostdin` と `stdin=subprocess.DEVNULL` を追加し、バックグラウンド実行時の停止を防いだ。
  - `sequence complete` マーカー待機上限を `max(MOD_MARKER_TIMEOUT_SEC + 30.0, 300.0)` 秒へ引き上げた。
  - `--gpu-encode` 有効時は `_build_video_cmd()` が `h264_nvenc`（`-preset p4 -rc vbr -cq 23 -b:v 5M -maxrate 6M -pix_fmt yuv420p`）を使用するよう対応した。

### 1.2 `th12` の AWS 60fps 頭打ち原因特定と `MyGetRasterStatus` フック修正

ローカル `Xvfb` では約 `3.4〜3.7倍速` で動いていた `th12` が、AWS `c7i.4xlarge` 上の初回検証（`<INSTANCE_ID>`）で **`60.0fps (1.00倍速)`・`game=15.38〜15.43ms`** に張り付いた。

- **原因**: `th12.cfg` オフセット `0x23`（メモリ上の `0x4cead3`）が `2` のとき、`th12.exe` のフレーム待機関数 `0x4501e0`（`0x4502da`〜`0x45032d`）は `IDirect3DDevice9::Present` の直前に `IDirect3DDevice9::GetRasterStatus(0, &status)`（`vtable[19]`）をループ呼び出しし、`InVBlank` が `0` になるまで待つ。Wine の `wined3d_output_get_raster_status`（`0x10079a60`）が `wineserver` とフック外の壁時計 `QueryPerformanceCounter` から VBlank / ScanLine を模擬しており、これが AWS の `Xvfb :93` 上で毎フレーム約 `15ms` 待機させていた（`th15.exe` `0x47263c` はウィンドウモードでは `GetRasterStatus` をスキップするため影響を受けなかった）。
- **修正**（`mods/common/frame_sync_hook.cpp` lines 38-43, 468-489）:
  - `MyGetRasterStatus(void* dev, UINT swapChain, RasterStatus* status)` を追加し、`g_virtualMode != 0` のとき `status->InVBlank = TRUE; status->ScanLine = 0;` を即座に返して `0` (`D3D_OK`) を返すようにした。
  - `OnPrePresent()` 初回（未フック時）に `dev` の `vtable[19]` を書き換えて `MyGetRasterStatus` へ差し替える（`FrameSync: hooked GetRasterStatus (vtable[19])` を出力）。
  - `bash mods/common/build_mingw.sh th12 && bash mods/common/build_mingw.sh th15` で DLL を再ビルドした。
- **効果確認**:
  - ローカル短尺確認 `test_getraster`（`th12_01.rpy`, `--record-seconds 40`）: `FrameSync: hooked GetRasterStatus (vtable[19])` 出力、`207.2fps (3.45倍速)`、`3391=3391` フレーム、音声端数0バイト。
  - AWS `c7i.4xlarge` 再計測（`<INSTANCE_ID>`）: `game` が `15.38〜15.43ms` → **`0.94ms`（Extra）/ `0.77ms`（Hard）** へ激減し、速度が `1.00倍速` → **`2.31倍速`（Extra）/ `2.33倍速`（Hard）** へ向上した。

### 1.3 ローカル決定性比較 `scripts/109_compare_determinism.py` の THP コンパクション回避

検証中、別用途の ROCm プロセス（`PID 3322587`）がカーネル D 状態（`amdgpu_tlb_fence_work`）に陥っていたホスト上で `scripts/109_compare_determinism.py` を起動すると、新規 `python3` プロセスまで `svm_range_cpu_invalidate_pagetables` で D 状態ハングする事象が発生した（`PID 3331929`, `PID 3742986`）。

- **原因**: ホストの `/sys/kernel/mm/transparent_hugepage/defrag` が `[madvise]` であり、ページキャッシュ約 51.5GiB 使用中（`MemFree` 約 679MiB）の状態で Linux x86_64 版 NumPy が 2MiB 以上の配列確保時に自動で `madvise(MADV_HUGEPAGE)` を発行するため、同期メモリコンパクション（`compact_zone`）が走って別プロセスの AMDGPU SVM ページ移動を試み、デッドロックしていた。
- **対策**: `scripts/109_compare_determinism.py` の先頭（`import numpy as np` より前）に `os.environ.setdefault("NUMPY_MADVISE_HUGEPAGE", "0")` と `ctypes.CDLL(None).prctl(41, 1, 0, 0, 0)`（`PR_SET_THP_DISABLE = 41`）を組み込み、4KB（order-0）ページのみで確保させることでハングを完全に回避した（比較結果には影響しない）。

---

## 2. 調査課題1: 同居プロセス負荷下の決定性検証

### 2.1 実験条件と基準動画

検証対象リプレイ（`node ../sattori/packages/replay-parser/dist/cli/index.js` による理論値）と無負荷基準動画（フェーズ105・109で採取）は次のとおり。

- **基準動画**:
  - `th12` Extra (`th12_01.rpy`, `frameCount=41454 (690.90s)`, スコア `195699630`): `/mnt/cache3/sattori-th12-verify/phase105/b2_th12_01_extra/video.mp4` (`43071f`)
  - `th12` Hard (`th12_02.rpy`, `frameCount=102326 (1705.43s)`, スコア `183240710`): `/mnt/cache3/sattori-th12-verify/phase105/b3_th12_hard_full/video.mp4` (`103679f`)
  - `th15` Extra (`th15_08.rpy`, `frameCount=45872 (764.53s)`, スコア `110347900`): `/mnt/cache3/sattori-th15-verify/phase105/b1_th15_extra_full/video.mp4` (`47863f`)
  - `th15` Hard (`th15_07.rpy`, `frameCount=120816 (2013.60s)`, スコア `417201130`): `/mnt/cache3/sattori-th15-verify/phase109/c7i_4xlarge/th15_hard.mp4` (`122511f`)
- **ローカル事前準備**: 実験開始前に `sattori-home-worker` サービスが停止済み（`inactive`）であることを確認した。
- **高負荷ワークロード**:
  - **実験1A（ローカル2タイトル並列）**: 独立した `WINEPREFIX` とゲームコピーを用い、`th12_01.rpy` と `th15_08.rpy` を同時並列録画（Ryzen 7 5700X, 8コア16スレッド）。
  - **実験1B（ローカル 16ワーカー CPU 100%飽和）**: `python3 scripts/109_cpu_load.py --workers 16` で全16スレッドを飽和させた状態で個別に録画（`mpstat` 上 `%idle 0.00〜0.37%`）。
  - **クラウド負荷実験（`c7i.2xlarge` `load8`）**: EC2 `c7i.2xlarge`（8 vCPU）上で `LOAD_WORKERS=8` として `109_cpu_load.py --workers 8` を並走させた状態で `th12_01.rpy`・`th15_08.rpy` を録画（`mpstat` 上 `%idle 0.00〜0.38%`）。

### 2.2 再現コマンド

```bash
# ローカル負荷生成 (別ターミナルまたはバックグラウンド)
python3 scripts/109_cpu_load.py --workers 16

# 決定性比較 (映像・音声のドリフトと残差)
export PATH="$HOME/.asdf/shims:$PATH"
python3 scripts/109_compare_determinism.py <REF.mp4> <CAND.mp4>

# プレイ区間の落ちフレーム計測 (th12 Extra: --start 20 --duration 670 / th15 Extra: --start 20 --duration 744)
python3 scripts/81_analyze_stutter_periodicity.py --start 20 --duration 670 <VIDEO.mp4>
```

### 2.3 負荷実験の結果一覧

| 条件 | 対象 | 上限解除速度 | 総フレーム (映像=音声) | 音声不整合 (`refill_to`/`unk_play`) | プレイ区間落ち (`81`) | 映像 `lag` / `drift` | 全区間 MAD `mean` (`>2.0f`) | 音声 `lag` / `drift` | `A/V差` | 音声残差 `med` (基準比) | スコア一致 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ローカル `1a_parallel` | th12 Extra | `76.3fps (1.27x)` | `43079` (端数0) | `0 / 0` | `70 (0.2%, 59.90fps)` | `-22f` / `[0,0,0]f` | `0.2910` (`0f`) | `-16170samp` / `[0,0,0]` | `0samp (0.0ms)` | `-24.65dBFS` (`-17.61dB`) | 一致 (`195699630`) |
| ローカル `1a_parallel` | th15 Extra | `53.6fps (0.89x)` | `47831` (端数0) | `0 / 0` | **`0 (0.0%, 60.00fps)`** | `-27f` / `[0,0,0]f` | `1.1827` (`5198f`※) | `-19845samp` / `[0,0,0]` | `0samp (0.0ms)` | `-27.65dBFS` (`-19.43dB`) | 一致 (`110347900`) |
| ローカル `1b_load16` (16w, idle 0%) | th12 Extra | `11.5fps (0.19x)` | `43183` (端数0) | `0 / 0` | `78 (0.2%, 59.89fps)` | `+52f` / `[0,0,0]f` | `0.2916` (`0f`) | `+38220samp` / `[0,0,0]` | `0samp (0.0ms)` | `-24.68dBFS` (`-17.63dB`) | 一致 (`195699630`) |
| ローカル `1b_load16` (16w, idle 0%) | th15 Extra | `6.5fps (0.11x)` | `47975` (端数0) | `0 / 0` | **`0 (0.0%, 60.00fps)`** | `+37f` / `[0,0,0]f` | `1.1849` (`5182f`※) | `+27195samp` / `[0,0,0]` | `0samp (0.0ms)` | `-27.6dBFS` (`-19.4dB`) | 一致 (`110347900`) |
| AWS `c7i.2xlarge load8` (8w, idle 0%) | th12 Extra | `35.9fps (0.60x)` | `43223` (端数0) | `0 / 0` | `78 (0.2%, 59.89fps)` | `+78f` / `[0,0,0]f` | `0.2930` (`0f`) | `+57330samp` / `[0,0,0]` | `0samp (0.0ms)` | `-24.82dBFS` (`-17.8dB`) | 一致 (`195699630`) |
| AWS `c7i.2xlarge load8` (8w, idle 0%) | th15 Extra | `18.2fps (0.30x)` | `47871` (端数0) | `0 / 0` | **`0 (0.0%, 60.00fps)`** | `+48f` / `[0,0,0]f` | `1.1664` (`5183f`※) | `+35280samp` / `[0,0,0]` | `0samp (0.0ms)` | `-27.66dBFS` (`-19.42dB`) | 一致 (`110347900`) |

※注: `th15` Extra の `MAD>2.0=5182〜5198f` は `phase105` 同士の基準比較 `a5` vs `b1`（`mean=1.1630, MAD>2.0=5199f`, 音声残差 `-27.49dBFS` / 基準比 `-19.34dB`）と同一水準であり、リプレイ外のスペルカード終了演出や起動時刻乱数等によるゲーム内未決定背景パーティクル差分に由来する。`anchor_mad` は序盤 `0.46〜0.51`・中盤 `0.25〜0.29`・終盤 `2.47〜2.69`、映像/音声ドリフトはいずれも `[0, 0, 0]` である。

1フレームあたりの内訳（`.summary.txt`）は、ローカル `1b_load16` では CPU 奪い合いで `th12` `game=61.42ms / readback=13.38ms / write=11.58ms`（合計 `86.40ms`）、`th15` `game=99.52ms / readback=36.80ms / write=17.47ms`（合計 `153.82ms`）、`c7i.2xlarge load8` では `th12` `7.45 / 11.35 / 8.79ms`（計 `27.61ms`）、`th15` `7.07 / 35.71 / 11.89ms`（計 `54.67ms`）と大幅に引き伸ばされたが、フレーム同期機構により録画内容自体は1フレーム・1サンプルのズレもなく保持された。

---

## 3. 調査課題2: AWS スポットインスタンス検証（CPU / GPU）

### 3.1 テストセルとスポット在庫状況

スポット単価 `<= $0.20/h`・同時起動最大1台の条件で実施。`c7i.xlarge` は `eu-south-2a/b/c` および `us-west-2d/a/c` のすべてで `InsufficientInstanceCapacity`（PlaceScore 1）、`g6f.2xlarge` は `us-west-2` の `$0.20/h` 以下 AZ（`2c` `$0.1687/h`, `2a` `$0.1900/h`; `2b` は `$0.2319/h` のため除外）がいずれも `InsufficientInstanceCapacity` で確保できなかったため、CPU 4 vCPU 枠は同世代の **`m7i.xlarge`**（`eu-south-2c`, `$0.0313/h`）、GPU 枠は **`g6f.xlarge`**（`us-west-2c`, `$0.0767/h`, NVIDIA L4-3Q 3GiB + 4 vCPU）を用いた。なお `g6f` 検証は本番 G 系クォータと干渉しない `us-west-2` で行った。

- 使用スクリプト: `scripts/109_run_cloud_cell.sh` → `scripts/109_launch_spot.sh` → `scripts/109_provision_instance.sh` → `scripts/109_run_cloud_framesync_batch.sh` → `scripts/109_pull_results.sh`（GPU 環境は `scripts/89_setup_gpu_instance.sh` + `scripts/109_run_gpu_post.sh`、`th15` CPU は `--cpu-display`、`th12` GPU は `--gpu-display`）。

### 3.2 クラウド実測結果（フル尺全19本）

全ランが **試行1回目で完走** し、`frames_written == frames_mixed`、`refill_timeouts=0`、`unknown_plays=0`、音声端数0バイト、および `ScoreMonitor` スコア完全一致を確認した。

| インスタンス (Spot単価・AZ) | ラベル | 動画フレーム / 音声長 | 録画全体実時間 (開始→終了) | 上限解除中平均 fps (倍率) | 600f窓 min / p5 / med / max | 1f平均内訳 (ms) `game / rb / wr / pres` | プレイ区間落ち (`81`) | 決定性 `lag` / `drift` / `MAD>2.0f` / `A/V差` |
|---|---|---|---|---|---|---|---|---|
| `c7i.4xlarge` (`$0.0982`, `eus2b`) | `th12_extra` ※修正前 | `43319` | `722.2s` (batch `745s`) | `60.0fps (1.00x)` | `59.5 / 60.0 / 60.0 / 60.0` | `15.38 / 0.11 / 1.02 / 0.05` | — (全範囲 `2.1%`) | `+176f` / `[0,0,0]` / `0f` / `0.0ms` |
| `c7i.4xlarge` (`$0.0982`, `eus2b`) | `th12_hard` ※修正前 | `103887` | `1731.6s` (batch `1780s`) | `60.0fps (1.00x)` | `59.7 / 60.0 / 60.0 / 60.0` | `15.43 / 0.11 / 1.01 / 0.02` | — (全範囲 `0.8%`) | `+189f` / `[0,0,0]` / `0f` / `0.0ms` |
| `c7i.4xlarge` (`$0.0982`, `eus2b`) | `th12_extra_unthrottled` | `43319` | `318.4s` (batch `346s`) | **`138.5fps (2.31x)`** (`2.33x`ログ) | `91.7 / 112.9 / 139.8 / 167.6` | `0.94 / 4.11 / 1.95 / 0.10` | `78 (0.2%, 59.89fps)` | `+180f` / `[0,0,0]` / `0f` / `0.0ms` |
| `c7i.4xlarge` (`$0.0982`, `eus2b`) | `th12_hard_unthrottled` | `103919` | `748.9s` (batch `803s`) | **`139.8fps (2.33x)`** (`2.34x`ログ) | `91.7 / 108.4 / 143.2 / 178.9` | `0.77 / 4.42 / 1.81 / 0.04` | `2 (0.0%, 60.00fps)` | `+197f` / `[0,0,0]` / `0f` / `0.0ms` |
| `c7i.4xlarge` (`$0.0982`, `eus2b`) | `th15_extra` | `47903` | `667.3s` (batch `706s`) | **`72.0fps (1.20x)`** | `34.9 / 50.2 / 77.4 / 86.7` | `0.75 / 10.37 / 2.54 / 0.12` | **`0 (0.0%, 60.00fps)`** | `+86f` / `[0,0,0]` / `5135f`※ / `0.0ms` |
| `c7i.4xlarge` (`$0.0982`, `eus2b`) | `th15_hard` (新基準) | `122511` | `1380.6s` (batch `1458s`) | **`88.9fps (1.48x)`** | `66.2 / 72.3 / 89.9 / 118.2` | `0.72 / 8.08 / 2.29 / 0.05` | `3 (0.0%, 60.00fps)` | (基準 `c7i_4xlarge/th15_hard`) |
| `c7i.2xlarge` (`$0.0595`, `eus2c`) | `th12_extra` | `43327` | `415.4s` (batch `444s`) | **`105.4fps (1.76x)`** (`1.77x`ログ) | `85.9 / 91.3 / 105.0 / 129.1` | `1.23 / 5.11 / 2.90 / 0.11` | `78 (0.2%, 59.89fps)` | `+184f` / `[0,0,0]` / `0f` / `0.0ms` |
| `c7i.2xlarge` (`$0.0595`, `eus2c`) | `th12_hard` | `103903` | `988.6s` (batch `1046s`) | **`105.6fps (1.76x)`** | `66.3 / 81.0 / 108.2 / 143.3` | `0.96 / 5.54 / 2.79 / 0.04` | `2 (0.0%, 60.00fps)` | `+197f` / `[0,0,0]` / `0f` / `0.0ms` |
| `c7i.2xlarge` (`$0.0595`, `eus2c`) | `th15_extra` | `48015` | `1194.4s` (batch `1236s`) | **`40.1fps (0.67x)`** | `23.1 / 30.1 / 41.5 / 49.5` | `1.31 / 18.81 / 4.68 / 0.02` | **`0 (0.0%, 60.00fps)`** | `+82f` / `[0,0,0]` / `5184f`※ / `0.0ms` |
| `c7i.2xlarge` (`$0.0595`, `eus2c`) | `th15_hard` | `122511` | `2559.4s` (batch `2680s`) | **`47.8fps (0.80x)`** | `36.6 / 39.0 / 48.6 / 64.1` | `1.31 / 15.31 / 4.13 / 0.03` | `4 (0.0%, 60.00fps)` | `+7f` / `[0,0,0]` / `6897f`※ / `0.0ms` |
| `m7i.xlarge` (`$0.0313`, `eus2c`) | `th12_extra` | `43327` | `641.9s` (batch `669s`) | **`67.6fps (1.13x)`** | `54.7 / 59.6 / 66.9 / 82.6` | `1.52 / 8.20 / 4.78 / 0.11` | `75 (0.2%, 59.89fps)` | `+183f` / `[0,0,0]` / `0f` / `0.0ms` |
| `m7i.xlarge` (`$0.0313`, `eus2c`) | `th12_hard` | `103903` | `1576.9s` (batch `1631s`) | **`65.9fps (1.10x)`** | `41.3 / 49.7 / 66.5 / 89.9` | `1.34 / 9.24 / 4.37 / 0.04` | `2 (0.0%, 60.00fps)` | `+197f` / `[0,0,0]` / `0f` / `0.0ms` |
| `m7i.xlarge` (`$0.0313`, `eus2c`) | `th15_extra` | `47887` | `2276.4s` (batch `2318s`) | `20.9fps (0.35x)` | `12.9 / 15.9 / 21.9 / 27.5` | `1.67 / 36.98 / 8.93 / 0.01` | **`0 (0.0%, 60.00fps)`** | `+70f` / `[0,0,0]` / `5180f`※ / `0.0ms` |
| `g6f.xlarge` (`$0.0767`, `usw2c`, NVENC) | `th12_extra` | `43327` | `722.5s` (batch `748s`) | `60.0fps (1.00x)` | `59.6 / 60.0 / 60.0 / 60.6` | `3.92 / 0.51 / 12.02 / 0.04` | `40 (0.1%, 59.94fps)` | `+182f` / `[0,0,0]` / `0f` / `0.0ms` |
| `g6f.xlarge` (`$0.0767`, `usw2c`, NVENC) | `th12_hard` | `103895` | `1729.5s` (batch `1780s`) | `60.1fps (1.00x)` | `59.5 / 60.0 / 60.0 / 61.1` | `3.83 / 0.55 / 12.09 / 0.03` | `1 (0.0%, 60.00fps)` | `+194f` / `[0,0,0]` / `0f` / `0.0ms` |
| `g6f.xlarge` (`$0.0767`, `usw2c`, NVENC) | `th15_extra` | `47871` | `800.7s` (batch `843s`) | `59.9fps (1.00x)` | `58.3 / 59.5 / 60.0 / 60.2` | `3.92 / 0.04 / 12.54 / 0.04` | **`0 (0.0%, 60.00fps)`** | `+48f` / `[0,0,0]` / `5458f`※ / `0.0ms` |
| `g6f.xlarge` (`$0.0767`, `usw2c`, NVENC) | `th15_hard` | `122471` | `2044.1s` (batch `2108s`) | `59.9fps (1.00x)` | `59.0 / 59.7 / 60.0 / 60.2` | `3.90 / 0.06 / 12.55 / 0.02` | `2 (0.0%, 60.00fps)` | `-39f` / `[0,0,0]` / `13831f`※ / `0.0ms` |

※注: `th15` Hard の `c7i.2xlarge` vs `c7i.4xlarge` では全区間 `118904f` 中 `MAD mean=0.7915, p99=9.4764, max=27.9492, MAD>2.0=6897f`・`anchor_mad=[0.678, 1.954, 0.264]`・音声残差 `-26.8dBFS`（基準比 `-18.21dB`）。GPU (`g6f.xlarge` NVENC) vs CPU 基準 (`c7i_4xlarge`) でも `th12` は `MAD>2.0=0f`（Extra `mean=0.3672`, Hard `mean=0.3795`）で完全一致、`th15` はエンコーダ差と背景乱数分のみで `drift=[0,0,0]`, `A/V=0.0ms`, 音声残差中央値 `-26.82〜-27.68dBFS` で波形・タイミングともに一致した。

### 3.3 `g6f.xlarge` の `write=12.0〜12.9ms` (`1.00倍速`) 律速の切り分け

GPU 描画+NVENC の `g6f.xlarge`（4 vCPU + NVIDIA L4-3Q）では `readback=0.04〜0.55ms` と極めて速い一方、`write=12.02〜12.55ms` が発生して `game+readback+write=16.5ms` (`60.0fps = 1.00倍速`) となった（`mpstat` は idle `43〜56%`、`nvidia-smi dmon` は SM `13〜44%`, enc `4〜5%` でいずれも未飽和）。原因切り分けとして `th15_08.rpy` で `--record-seconds 40` の3条件プローブ（`scripts/109_run_gpu_post.sh`）を追加実行した。

| プローブ (`th15_08.rpy` 40秒) | 映像エンコーダ | `FRAME_SYNC_SKIP_PRESENT` | 上限解除速度 | 内訳 `game / readback / write / present` (ms) | スコア |
|---|---|---|---|---|---|
| `th15_probe_x264_pres0` | `libx264` (`veryfast`) | `0` | `54.6fps (0.91x)` | `4.36 / 0.49 / 12.96 / 0.36` | `498790` |
| `th15_probe_nvenc_pres0` | `h264_nvenc` (`p4`) | `0` | `59.8fps (1.00x)` | `3.73 / 0.11 / 12.43 / 0.32` | `498827` |
| `th15_probe_nvenc_skip1` | `h264_nvenc` (`p4`) | `1` | `59.6fps (0.99x)` | `3.73 / 0.15 / 12.35 / 0.43` | `498820` |

`x264` / `NVENC` / `SKIP_PRESENT=1`、また解像度差（`th12` 640x480 vs `th15` 1280x960）に関わらず `write` は一律 `12.0〜12.9ms` となり、ゲームスレッドとパイプ書き出し間の同期側で 60Hz 相当に頭打ちとなっていた（オフラインの `scripts/109_bench_convert.py --gpu-encode` は **3.87〜3.95倍速** で動作）。

---

## 4. 調査課題3: 配信版変換ベンチマークとコスト比較

### 4.1 配信版変換ベンチマーク（`scripts/109_bench_convert.py`）

`../sattori/worker/convert.py` と同等の2出力変換（カット + 720p/1080p Lanczos 拡大 + VP9 透かし合成の `delivery.mp4` と、透かし無し `raw.mp4` を同時生成）を各インスタンス上で実測した。`--frame-sync` は生録画時点で既に60fps等倍のタイムスタンプを持つため、変換時の速度復元（倍速/低速時のフレーム間引き・重複除去）は不要である。

| インスタンス | 設定 | `th12_extra` (`640x480→960x720`, `play_dur=696s`) | `th15_extra` (`1280x960→1440x1080`, `play_dur=772〜774s`) |
|---|---|---|---|
| `c7i.4xlarge` (16 vCPU) | CPU (`libx264 veryfast`) | `113.89s` (**ratio `0.1636`** / `6.11x`) | `289.64s` (**ratio `0.3750`** / `2.67x`) |
| `c7i.2xlarge` (8 vCPU) | CPU (`libx264 veryfast`) | `164.80s` (**ratio `0.2367`** / `4.22x`) | `518.11s` (**ratio `0.6692`** / `1.49x`) |
| `m7i.xlarge` (4 vCPU) | CPU (`libx264 veryfast`) | `279.70s` (**ratio `0.4018`** / `2.49x`) | `981.47s` (**ratio `1.2711`** / `0.79x`) |
| `g6f.xlarge` (4 vCPU+L4-3Q) | `--gpu-encode` (`h264_nvenc p4`) | `176.20s` (**ratio `0.2531`** / `3.95x`) | `199.63s` (**ratio `0.2586`** / `3.87x`) |

### 4.2 Spot 単価スナップショット（2026-11-18 UTC 実測 vs 2026-11-08 基準）

`aws ec2 describe-spot-price-history --product-descriptions "Linux/UNIX"` で確認した価格（USD/時間）:
- `eu-south-2`: `c7i.4xlarge` `2b=$0.0975〜0.0982 / 2c=$0.0982 / 2a=$0.1097`、`c7i.2xlarge` `2c=$0.0595〜0.0596 / 2b=$0.0601 / 2a=$0.0772`、`c7i.xlarge` `2b=$0.0516 / 2a=$0.0534 / 2c=$0.0539`、`m7i.xlarge` `2c=$0.0313 / 2a,2b=$0.0340`、`g6f.2xlarge` `2a=$0.1028 / 2b=$0.1790 / 2c=$0.5344`
- `eu-north-1`: `g6f.2xlarge` `1a=$0.0814 / 1b=$0.0712`、`g6f.xlarge` `1a=$0.0694 / 1b=$0.0665`
- `us-west-2`: `g6f.xlarge` `2c=$0.0767〜0.0776 / 2b=$0.0785 / 2a=$0.0846`、`g6f.2xlarge` `2c=$0.1687〜0.1723 / 2a=$0.1900〜0.1906`

### 4.3 リプレイ尺1時間（3600秒）あたりの課金時間・費用比較表

`../sattori/docs/reports/2026-11-08-recommended-speed-fallback-order-and-cost.md` と同一のモデル（`課金時間 = 固定 180s(0.05h) + 録画実時間 + 変換時間`、`時間単価 = Spot単価 + EBS/IPv4 $0.0086/h`）で算出した。Phase 109 は各インスタンスの実測値（`録画全体実時間/動画時間` と `convert_bench.py` 実測 `ratio`）を、従来方式は同報告書の式（GPU変換比 `0.08`・CPU変換比 `0.22`）を用いた上で、同一日の Spot 単価でも比較する。

#### `th12`（640x480）のコスト比較

| 方式・インスタンス | 録画倍率 | 課金時間/尺1h | 適用単価 (USD/h) | **費用/尺1h** | 11-08基準単価換算 | 品質・備考 |
|---|---|---|---|---|---|---|
| **従来** `g6f.2xlarge` GPU 2倍速 (`eun1b`/`eus2a`/`eus2b`) | `2.0x` | `0.655h` (`39.3m`) | `$0.0712`〜`$0.1790` | `$0.052`〜`$0.123` | `$0.046`〜`$0.078` | GPU 8vCPU 枠を消費 |
| **従来** `c7i.2xlarge` CPU 等倍 (`eus2c`, 旧 `ratio=0.22`) | `1.00x` | `1.270h` (`76.2m`) | `$0.0595` | `$0.087` | `$0.064` | reports/102: 落ち3.1〜3.3%で**基準外** |
| **Phase 109** `c7i.4xlarge` CPU | **`2.31〜2.33x`** | **`0.646〜0.655h`** (`39m`) | `$0.0982` (`2b`) | **`$0.069〜$0.070`** | `$0.061〜$0.062` | 落ち `0.0〜0.2%`。最速 (GPU 2x相当時間) |
| **Phase 109** `c7i.2xlarge` CPU | **`1.76x`** | **`0.858〜0.862h`** (`52m`) | `$0.0595` (`2c`) | **`$0.058〜$0.059`** | **`$0.044`** | **落ち `0.0〜0.2%`。旧CPU等倍比 -32%・GPU不要** |
| **Phase 109** `m7i.xlarge` CPU (4 vCPU) | **`1.10〜1.13x`** | **`1.341〜1.362h`** (`81m`) | `$0.0313` (`2c`) | **`$0.053〜$0.054`** | **`$0.047〜$0.048`** | **従来不可の4vCPU帯を解禁**。落ち `0.0〜0.2%` |
| **Phase 109** `g6f.xlarge` GPU (`usw2c` / `eun1b`) | `1.00x` | `1.302〜1.304h` (`78m`) | `$0.0767` / `$0.0665` | `$0.111` / `$0.098` | `$0.111` / `$0.098` | CPUより高コスト（GPU利用意義なし） |

#### `th15`（1280x960）のコスト比較

| 方式・インスタンス | 録画倍率 | 課金時間/尺1h | 適用単価 (USD/h) | **費用/尺1h** | 11-08基準単価換算 | 従来CPU比 / 備考 |
|---|---|---|---|---|---|---|
| **従来** `g6f.2xlarge` GPU 2倍速 (`eun1b`/`eus2a`/`eus2b`) | `2.0x` | `0.655h` (`39.3m`) | `$0.0712`〜`$0.1790` | `$0.052`〜`$0.123` | `$0.046`〜`$0.078` | GPU 8vCPU 枠を消費 |
| **従来** `c7i.4xlarge` CPU 1/2倍速 (通常, 旧 `ratio=0.22`) | `0.50x` | `2.330h` (`139.8m`) | `$0.0982` | `$0.249` | `$0.221` | 実時間120分上限で尺約58分打ち切り |
| **従来** `c7i.4xlarge` CPU 1/3倍速 (Extra, 旧 `ratio=0.22`) | `0.333x` | `3.360h` (`201.6m`) | `$0.0982` | `$0.359` | `$0.319` | 実時間120分上限で尺約39分打ち切り |
| **Phase 109** `c7i.4xlarge` CPU (Extra) | **`1.20x`** | **`1.261h`** (`75.7m`) | `$0.0982` (`2b`) | **`$0.135`** | **`$0.120`** | **落ち `0.0%`。従来 Extra CPU比 -62.5%** |
| **Phase 109** `c7i.4xlarge` CPU (Hard) | **`1.48x`** | **`1.101h`** (`66.1m`) | `$0.0982` (`2b`) | **`$0.118`** | **`$0.105`** | **落ち `0.0%`。従来 Hard CPU比 -52.7%** |
| **Phase 109** `c7i.2xlarge` CPU (Extra) | **`0.67x`** | `2.212h` (`132.7m`) | `$0.0595` (`2c`) | **`$0.151`** | **`$0.112`** | **落ち `0.0%`。従来 Extra 比 -58.0%** (変換比 `0.6692` が大きめ) |
| **Phase 109** `c7i.2xlarge` CPU (Hard) | **`0.80x`** | `1.973h` (`118.4m`) | `$0.0595` (`2c`) | **`$0.134`** | **`$0.100`** | **落ち `0.0%`。従来 Hard 比 -46.0%** |
| **Phase 109** `m7i.xlarge` CPU (Extra, 4 vCPU) | `0.35x` | `4.173h` (`250.4m`) | `$0.0313` (`2c`) | `$0.167` | `$0.147` | 変換比 `1.2711` + 長時間で逆高・120分上限注意 |
| **Phase 109** `g6f.xlarge` GPU (`usw2c` / `eun1b`) | `1.00x` | `1.310〜1.312h` (`78.7m`) | `$0.0767` / `$0.0665` | **`$0.112`** / **`$0.098`** | `$0.112` / `$0.098` | **落ち `0.0%`・GPU 4vCPU 枠で動作** |

※注: 同一の `worker/convert.py` 変換（`c7i.4xlarge` 実測比 `0.3750`）を前提にすると、従来 `c7i.4xlarge` CPU 1/3倍速の課金時間は `3.515h ($0.375/h)` となり、Phase 109 による実質削減幅はさらに約 0.155 時間分大きい。

### 4.4 本番サービス（`../sattori`）への反映に向けた推奨事項

1. **`th12` への即時採用メリットが極めて大きい**:
   - `c7i.2xlarge` 等倍では落ち3%台で品質基準外だったが、`--frame-sync` により **GPU を使わずに `c7i.2xlarge` で `1.76倍速` / 落ち `0.0〜0.2%` / 費用 `$0.058`/時**（`eu-south-2` の `g6f.2xlarge` 2倍速より安価）、さらに **`m7i.xlarge`（4 vCPU）でも `1.10〜1.13倍速` / `$0.054`/時** で高品質録画が成立する。自宅ワーカーと同等品質・GPU 枠消費ゼロでスケールでき、旧 `recordingPlan.ts` の `speedupPlan(2, CPU_2XLARGE_INSTANCE_TYPES)` における GPU 先頭配置を見直す根拠となる。
2. **`th15` の CPU フォールバック（および GPU 枯渇時）の劇的改善**:
   - `c7i.4xlarge` + `--frame-sync` により、従来の `1/3倍速`・`1/2倍速`（尺1時間あたり `$0.25〜0.36`, 実時間2〜3時間超, 落ち0.5〜1.3%）を **`1.20〜1.48倍速`・`$0.12〜0.14`/時・落ち `0.0%`** へ半減以下・高速化できる。
   - Spot 枯渇時の CPU フォールバック先として `c7i.2xlarge`（`0.67〜0.80倍速`, `$0.13〜0.15`/時, 落ち `0.0%`）も新しく安全に追加できる（`m7i.xlarge` 4 vCPU は 1440x1080 変換を含めるとコスト・時間ともに不利）。
   - GPU 段については 4 vCPU の `g6f.xlarge`（G系クォータ半分）でも `1.00倍速`・`0.0%` 落ち・`$0.10〜0.11`/時で安定稼働するため、G 系クォータの節約または `.2xlarge` 枯渇時の GPU 段候補として有効（`g6f.2xlarge` での `--frame-sync` 速度は今回は在庫枯渇により未測定）。
3. **残課題（フェーズ110以降）**:
   - **調査項目4（他タイトル展開）**: `th12`（D3D9 + DirectInput）・`th15`（D3D9 + DirectInput）以外のタイトル（`th06` / `th08` / `th09` D3D8、GetKeyboardState の `th11`、`th10` / `th128` / `th13` / `th14` / `th20`、`th06c` / `th06nc` D3D11）への `frame_sync_hook` / `frame_sync_audio` 展開と実機確認。
   - **運用面（`sattori` 側）**: 長時間・低倍率（`c7i.2xlarge` `0.67x` 等）に備えた `MAX_WALL_CLOCK_TIMEOUT_SEC` や重複フレーム異常検知の無効化（`--frame-sync` では出力が常に実ゲーム1フレーム=1動画フレームであり、従来のリアルタイム処理落ち検知は不要）および配信変換側 `ratio` 定数の更新。

---

## 5. 保存動画一覧と AWS クリーンアップ確認

### 5.1 視聴用保存ファイル（`/mnt/cache3/` 配下）

- **`th12`**:
  - ローカル並列・負荷:
    - `/mnt/cache3/sattori-th12-verify/phase109/local/1a_parallel/video.mp4`
    - `/mnt/cache3/sattori-th12-verify/phase109/local/1b_load16/video.mp4`
    - 短尺確認: `/mnt/cache3/sattori-th12-verify/phase109/local/test25/video.mp4`, `/mnt/cache3/sattori-th12-verify/phase109/local/test_getraster/video.mp4`
  - AWS `c7i.4xlarge`:
    - `/mnt/cache3/sattori-th12-verify/phase109/c7i_4xlarge/th12_extra_unthrottled.mp4`（修正後）, `th12_hard_unthrottled.mp4`（修正後）
    - `th12_extra.mp4`（修正前60fps上限）, `th12_hard.mp4`（修正前60fps上限）
  - AWS `c7i.2xlarge`:
    - `/mnt/cache3/sattori-th12-verify/phase109/c7i_2xlarge/th12_extra.mp4`, `th12_hard.mp4`, `th12_extra_load8.mp4`
  - AWS `m7i.xlarge`:
    - `/mnt/cache3/sattori-th12-verify/phase109/m7i_xlarge/th12_extra.mp4`, `th12_hard.mp4`
  - AWS `g6f.xlarge`:
    - `/mnt/cache3/sattori-th12-verify/phase109/g6f_xlarge/th12_extra.mp4`, `th12_hard.mp4`
- **`th15`**:
  - ローカル並列・負荷:
    - `/mnt/cache3/sattori-th15-verify/phase109/local/1a_parallel/video.mp4`
    - `/mnt/cache3/sattori-th15-verify/phase109/local/1b_load16/video.mp4`
  - AWS `c7i.4xlarge`:
    - `/mnt/cache3/sattori-th15-verify/phase109/c7i_4xlarge/th15_extra.mp4`, `th15_hard.mp4`
  - AWS `c7i.2xlarge`:
    - `/mnt/cache3/sattori-th15-verify/phase109/c7i_2xlarge/th15_extra.mp4`, `th15_hard.mp4`, `th15_extra_load8.mp4`
  - AWS `m7i.xlarge`:
    - `/mnt/cache3/sattori-th15-verify/phase109/m7i_xlarge/th15_extra.mp4`
  - AWS `g6f.xlarge`:
    - `/mnt/cache3/sattori-th15-verify/phase109/g6f_xlarge/th15_extra.mp4`, `th15_hard.mp4`
    - 短尺プローブ: `th15_probe_x264_pres0.mp4`, `th15_probe_nvenc_pres0.mp4`, `th15_probe_nvenc_skip1.mp4`

### 5.2 AWS リソース後片付け確認

全検証インスタンス（`c7i.4xlarge` 2台、`c7i.2xlarge` 1台、`g6f.xlarge` 1台、`m7i.xlarge` 1台）を順次 `terminate-instances` → `terminated` 待機したのち、一時キーペア `touhou-recorder-p109-key`（`eu-south-2`・`us-west-2`）、ローカル秘密鍵 `/tmp/touhou-recorder-p109-key.pem`、一時 SSH ルール `sgr-0d8cd8062a4bead4c`（`us-west-2` `<SECURITY_GROUP_ID>`）を削除し、`eu-south-2`・`us-west-2`・`us-east-1` の3リージョンで非 `terminated` インスタンスが **0台** であることを `aws ec2 describe-instances` で確認済み。
