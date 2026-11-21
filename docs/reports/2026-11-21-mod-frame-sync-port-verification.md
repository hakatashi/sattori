# フレーム同期キャプチャ MOD 移植(Issue #388)の実機検証

- **検証日**: 2026-11-21
- **対象**: Issue #388 (`MOD: フレーム同期キャプチャをtouhou-recorderから移植する`、親 Epic #399)
- **ブランチ**: `feat/mod-frame-sync-388`
- **環境**: HakataMatrix (`sattori-home-worker` 停止下でローカル直接実行。Xvfb + Wine + `llvmpipe` CPU 描画、`i686-w64-mingw32-g++` / `x86_64-w64-mingw32-g++`)
- **結論**: ビルド・ホスト単体テスト(`24 tests, 0 failed`)・インポート検査(17バイナリすべて `KERNEL32.dll`・`msvcrt.dll`・`USER32.dll` のみ)を通過し、本番全13タイトルのフレーム同期録画で映像フレーム数・`ffmpeg` デコード数・仮想音声ミックス数(`frames_written == ffmpeg_frame == frames_mixed`)の完全一致、PCM 端数 0B、期待スコア一致(`th09` は残機監視)を確認した。`FRAME_SYNC_PIPE` 未設定のリアルタイム回帰テストでも、11/12 タイトルが MOD 統合テスト OK、`th15` 低速録画(0.5倍速)も完走・スコア一致となり、`FrameSync:` 系出力は全タイトルでゼロだった(`th07` のみ `th7_12.rpy` 既知の 1 秒ポーリング位相による偽陽性を再現)。

## 1. 移植時の設計確認点

1. **D3D8 と D3D9 の実バイナリ境界**: `th06`・`th07`・`th08` は `d3d9.dll` ではなく `d3d8.dll!Direct3DCreate8` をインポートしているため、`th09` とともに `InstallFrameSyncD3D8` を使用した(`th06` は `stepDiv=1024`、`th07`・`th08`・`th09` は `32`)。D3D9 (`InstallFrameSyncD3D9`, `stepDiv=1024`) は `th10`・`th11`・`th12`・`th128`・`th13`・`th15`・`th20`、D3D11/DXGI (`InstallFrameSyncD3D11`, `stepDiv=64`) は `th06c`・`th06nc` を担当する。
2. **高倍速時のスコア監視間隔**: フレーム同期では実時間 5〜6 倍速相当で進むタイトルがあり、`ScoreMonitor` 既定の 1000ms (および 200ms) 間隔ではリプレイ終端の最終スコアを取りこぼすことが判明した(`th07`・`th08`)。`monitor/score_monitor.cpp` でフレーム同期時は `intervalMs` 上限を `20ms` に詰めたことで両タイトルとも最終スコアを安定して捕捉した。
3. **非フレーム同期タイトルへの無影響**: `FRAME_SYNC_PIPE` 未設定時は `InstallFrameSyncD3D*` が何もせず `false` を返し、`clock/virtual_clock`・`present/bus` フック(リアルタイムで `limiter` を使わないタイトル)とも組み込まれない。

## 2. フレーム同期モード検証(本番全13タイトル)

`worker/tests/fixtures/mod-integration/` の各タイトル短いリプレイ(および `th15/th15_09.rpy`)をフレーム同期環境変数(`FRAME_SYNC_PIPE` / `FRAME_SYNC_STOP` / `FRAME_SYNC_AUDIO` / `FRAME_SYNC_STEP_DIV` 未上書きで既定値を使用、`th06nc` は `D3D11_DECODE_BC7=1`)で実行し、`ffmpeg` へ流し込んで動画・音声・ログを検証した。

| タイトル | Backend | `stepDiv` | 解像度 / `pix_fmt` | 映像 (`written` / `present` / `ffmpeg`) | 仮想音声 (`mixed` / `notifies` / `refill_to` / `unk`) | 音量 (mean / max) | アンロック後実測 (`fps` / 倍速 / 所要時間) | スコア / 監視確認 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `th06` | D3D8 | 1024 | 640x480 / `bgr0` | 8175 / 8176 / 8175 | 8175 / 271 / 0 / 0 | -11.8dB / 0.0dB | 339.8fps (5.66x), 計44.8s (解除後19.7s) | `13,951,380` 一致 ※1 |
| `th07` | D3D8 | 32 | 640x480 / `bgr0` | 8639 / 8640 / 8639 | 8639 / 557 / 0 / 0 | -10.7dB / 0.0dB | 356.5fps (5.94x), 計40.1s (解除後21.2s) | `3,581,800` (`358180`) 一致 ※2 |
| `th08` | D3D8 | 32 | 640x480 / `bgr0` | 9775 / 9776 / 9775 | 9775 / 618 / 0 / 0 | -11.6dB / 0.0dB | 323.1fps (5.38x), 計46.0s (解除後26.8s) | `59,889,420` (`5988942`) 一致 |
| `th09` | D3D8 | 32 | 640x480 / `bgr0` | 7519 / 7520 / 7519 | 7519 / 478 / 0 / 0 | -13.2dB / 0.0dB | 300.4fps (5.01x), 計38.1s (解除後21.8s) | `scoreWidth=0`、`lives` 1→0 観測 |
| `th10` | D3D9 | 1024 | 640x480 / `bgr0` | 9559 / 9560 / 9559 | 9559 / 610 / 0 / 0 | -10.9dB / 0.0dB | 313.6fps (5.23x), 計43.1s (解除後27.5s) | `15,400,100` (`1540010`) 一致 |
| `th11` | D3D9 | 1024 | 640x480 / `bgr0` | 9247 / 9248 / 9247 | 9247 / 535 / 0 / 0 | -10.9dB / 0.0dB | 197.9fps (3.30x), 計57.2s (解除後42.2s) | `63,738,500` (`6373850`) 一致 |
| `th12` | D3D9 | 1024 | 640x480 / `bgr0` | 9855 / 9856 / 9855 | 9855 / 570 / 0 / 0 | -10.3dB / 0.0dB | 219.2fps (3.65x), 計55.9s (解除後40.9s) | `31,221,250` (`3122125`) 一致 |
| `th128` | D3D9 | 1024 | 640x480 / `bgr0` | 11623 / 11624 / 11623 | 11623 / 698 / 0 / 0 | -10.2dB / 0.0dB | 157.5fps (2.62x), 計83.6s (解除後68.2s) | `5,080,020` (`508002`) 一致 |
| `th13` | D3D9 | 1024 | 640x480 / `bgr0` | 7623 / 7624 / 7623 | 7623 / 195 / 0 / 0 | -11.7dB / 0.0dB | 182.3fps (3.04x), 計52.5s (解除後36.6s) | `6,617,760` (`661776`) 一致 |
| `th15` | D3D9 | 1024 | 1280x960 / `bgr0` | 11303 / 11304 / 11303 | 11303 / 330 / 0 / 0 | -11.9dB / 0.0dB | 69.7fps (1.16x), 計164.8s (解除後147.4s) | `17,101,210` (`1710121`) 一致 |
| `th20` | D3D9 | 1024 | 1280x960 / `bgr0` | 8735 / 8736 / 8735 | 8735 / 485 / 2 / 0 | -12.4dB / 0.0dB | 66.6fps (1.11x), 計134.5s (解除後116.3s) | `9,243,950` (`924395`) 一致 ※3 |
| `th06c` | D3D11 | 64 | 640x480 / `rgb0` | 8519 / 8520 / 8519 | 8519 / 8520 / 0 / 0 | -12.6dB / 0.0dB | 274.7fps (4.58x), 計38.0s (解除後29.2s) | `13,004,650` 一致、PNG目視良 |
| `th06nc` | D3D11 | 64 | 1280x720 / `rgb0` | 9527 / 9528 / 9527 | 9527 / 9528 / 0 / 0 | -21.3dB / -4.1dB | 97.2fps (1.62x), 計112.8s (解除後89.7s) | `25,890,400` 一致、PNG目視良 |

- 全13タイトルで RAW PCM 端数は 0 バイト、`ffmpeg.log` エラー件数は 0、`vpatch` 同梱タイトル(`vpatch_th06.dll`・`vpatch_th07.dll`・`vpatch_th10.dll`・`vpatch_th12.dll`)ではすべて `FrameSync: hooked vpatch IAT (...)` が記録された。
- ※1 `th06` のフレーム同期計測は `monitor/score_monitor.cpp` の `intervalMs` 上限を 200ms から 20ms へ引き下げる前に実施した(98サンプルで期待スコア `13,951,380` 一致を確認済み)。
- ※2 `th07` は `22:51:39.875` に期待スコア相当の `358180` (`graze=463`)を捕捉した後、`modlog.py` に既知のリプレイ終了後グローバル領域上書き(`20382120`)へ遷移した(`expected_score in scores` で一致)。
- ※3 `th20` は `refill_timeouts=2` を記録したが `unknown_plays=0`、`frames_written == frames_mixed == 8735` で音声・映像尺・期待スコアとも欠落なく完走した。

## 3. リアルタイムモード退行確認

1. **MOD 統合テスト (`worker/tests/mod_integration/run.py`)**:
   - `th06`・`th06c`・`th06nc`・`th08`・`th09`・`th10`・`th11`・`th12`・`th128`・`th13`・`th20` の 11 タイトルがすべて `exit=0` かつ被弾タイミング(およびスコア)一致で OK。
   - Issue #393 ベースラインログとの非スコア契約行比較では、全12タイトルで `FrameSync:`・`FrameSyncAudio:`・`InstallVirtualClock:` の出力が 0 行であり、`Present` フックを使わないタイトル(`th06`・`th07`・`th08`・`th10`・`th11`・`th12`)ではリアルタイム時に `InstallFpsLimiterHook`・`hooked Present` が出ないことも維持された。
   - `th07` (`th7_12.rpy`) のみ 2 回とも `desyncDetected: true` で NG となったが、`ScoreMonitor` の残機減少タイミングはベースラインと一致(`[(109.1, 354971, 1, 447), (115.1, 357174, 0, 458)]`)しており、`357380` (grazes=459) の直後に 1 秒間隔ポーリングの位相がメニュー復帰後の値(`20382xxx`)へ跨ぐ [`worker/tests/fixtures/mod-integration/README.md`](../../worker/tests/fixtures/mod-integration/README.md) 記載の既知個体差の再現だった。
2. **`th15` 低速リアルタイム検証 (`worker/record_th15.py`、`FPS_LIMIT_TARGET_HZ=30`、0.5 倍速 CPU)**:
   - `th15_09.rpy` に対し `exit=0` で試行 1 回完走(`総録画時間 378.0秒`、A/V 残差 `+0.2ms`、重複率 `57.9%` / 閾値 `90.0%`)、`desyncDetected=false`、`timedOut=false`、`ScoreMonitor` は `1710121` (`17,101,210`)を 3 回捕捉、`FrameSync:` 関連出力は 0 行だった。
