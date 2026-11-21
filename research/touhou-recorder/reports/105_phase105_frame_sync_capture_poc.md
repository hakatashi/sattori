# フェーズ105: フレーム同期キャプチャのPoC(映像のみ、th15・th12)

日付: 2026-11-16

## 結論

- **フレーム同期キャプチャ(reports/104)は映像について成立した。** ゲームの1フレームごとにMODがバックバッファを読み出してFIFOへ書き、ffmpegがそれを読む。描画・読み出し・エンコードの遅いほうが律速になり、ゲームは可変速で進む。
- ローカル(Ryzen 7 5700X、8コア16スレッド、Xvfb+wined3d+llvmpipe)でフル尺4本(th15 Extra・Hard全6面、th12 Extra・Hard全6面)を録り、**4本ともMODが書いたフレーム数と動画のフレーム数が一致し、スコアは記録と一致し、落ちフレームは0〜2(0.0%)。** 試行1回目で完走した。
- 処理速度(動画の秒数÷実時間)は **th15 Extra 1.17倍速、th15 Hard 1.50倍速、th12 Extra 3.47倍速、th12 Hard 3.50倍速**。th15 Hard全面(動画2040秒)は実時間1364秒で録れた。既存方式のCPU録画はth15で1/2倍速が必要(`c7i.4xlarge`で動画の2.03倍の実時間、reports/91)なので、同程度のCPUなら**録画時間は約1/3**になる見込み。ただしクラウドでは未測定。
- 画面上のfps表示は補正なしで60.0〜60.1fpsになる(チェックリスト項目10が不要)。
- **音声はまだ録れない**(この方式ではゲームが実時間で進まない)。本番で使うには音声の対応(reports/104 案A)が必須。

## 実装

### MOD側: `mods/common/frame_sync_hook.cpp/.h`(新規)

環境変数`FRAME_SYNC_PIPE`が設定されたときだけ有効になる(未設定なら何もしないので、既存の録画には影響しない)。

1. **仮想時計**: exeのIATの`QueryPerformanceCounter`・`timeGetTime`・`GetTickCount`・`Sleep`を差し替える。最初の`Present`以降、時刻は実時間と無関係になる。`Present`を呼ぶスレッド(メインスレッド)がタイマーを1回読むたびに1/60秒の1/1024(約16マイクロ秒)進み、`Sleep(n)`を呼ぶとnミリ秒進んで即座に戻る。他のスレッドは時計を進めずに読むだけで、`Sleep`も実時間のまま(BGMの補充スレッド等を空回りさせないため)。th15(QPCのビジーポーリング)・th12とも、内蔵のウェイトは実時間を使わずに抜けた。
2. **取り込み**: `fps_limiter_hook.cpp`の`Present`フックに前後のコールバック(`g_d3d9PrePresentCallback`/`g_d3d9PostPresentCallback`)を足し、前のコールバックで`GetBackBuffer`→`GetRenderTargetData`(システムメモリのサーフェスへ)→`LockRect`し、FIFOへ`WriteFile`する。FIFOが詰まれば`WriteFile`がブロックし、それがそのまま律速になる。
3. **読み出しのパイプライン化(既定で有効、`FRAME_SYNC_PIPELINE=0`で無効)**: サーフェスを2枚持ち、今のフレームの`GetRenderTargetData`を積んでから、1つ前のフレームのサーフェスを`LockRect`して書き出す。wined3dは描画をコマンドスレッド(llvmpipe)で非同期に処理するので、こうするとゲーム本体と書き込みが描画と並行して進む(§3.2)。停止時に残りの1フレームを書き出す(`FlushPending()`)。
4. **上限の切り替え**: 既定では既存の上限(実時間60Hz)が効いたまま。MODのメニュー操作は`Sleep`基準で、ロードも実時間で進むため、リプレイ再生のキー操作が終わった時点で`FrameSyncSetUnthrottled(true)`を呼んで上限を外す。
5. **停止**: 録画側が`FRAME_SYNC_STOP`のファイルを置くと、MODはFIFOを閉じて上限を戻す。

| 環境変数 | 意味 |
|---|---|
| `FRAME_SYNC_PIPE` | FIFOのWindows形式パス(録画側が設定) |
| `FRAME_SYNC_STOP` | 停止要求のファイル(録画側が設定) |
| `FRAME_SYNC_PIPELINE=0` | パイプライン化を切る |
| `FRAME_SYNC_SKIP_PRESENT=1` | 上限解除中は本来の`Present`(Xへの転送)を呼ばない |
| `FRAME_SYNC_PROBE_READBACK2=1` | 診断: 描画が終わった状態でもう一度読み出し、読み出しそのものの時間を`readback2_ms`に出す |
| `FRAME_SYNC_PROBE_NO_READBACK=1` | 診断: 読み出さずに黒いフレームを書く(描画だけの速度の上限) |

MODログには600フレームごとに`FrameSync: stats frame=... fps=... game_ms=... readback_ms=... write_ms=... present_ms=...`を出す。

組み込み: `mods/th15_replay_autoplay/dllmain.cpp`・`mods/th12_replay_autoplay/dllmain.cpp`で、`InstallSpeedHackHook()`の直後(`InstallFpsLimiterHook()`より前)に`InstallFrameSyncHook()`、キー操作の最後(`sequence complete`の直前)に`FrameSyncSetUnthrottled(true)`。

### 録画側: `recorder/framesync.py`(新規)、`--frame-sync`

- `RecordingOptions.frame_sync`(CLIは`--frame-sync`)で`attempt_recording()`がこちらへ分岐する。音声は録らない(`no_audio`扱い)。倍速・低速録画(`FPS_LIMIT_TARGET_HZ`)とは併用できない。
- FIFOを`instances/<title>/framesync.fifo`に作り、録画側も読み書き両用で開いておく(ffmpegの起動前にMODが開けるように。バッファは`F_SETPIPE_SZ`で1MiB)。MODログの`FrameSync: capture start width=... height=... pix_fmt=...`を見て、ffmpegを`-f rawvideo -framerate 60 -i <FIFO>`で起動する。
- 終了検知は通常の録画と同じ材料(サブ出力160x120 gray・8fps、画面静止8回連続/テンプレート2回連続)だが、**サブ出力の枚数=動画上の時刻**で数える(動画上で2秒おきに判定)。fps暴走検知・処理落ち早期検知は行わない。サブ出力が120秒増えなければゲームが止まったとみなして打ち切る。
- 停止後、MODの`frames_written`と`ffprobe`の動画のフレーム数を照合し、一致しなければ失敗(`setup_error`)にする。
- 後片付け(`kill_wine_and_wait()`)は`finally`で必ず行う。先にFIFOの読み口を閉じてffmpegへEOFを届ける。

### その他

- `mods/th15_replay_autoplay/build_mingw.sh`: ソース一覧に`d3dx_filter_hook.cpp`(reports/101)が無くリンクできなくなっていたので、共通の`mods/common/build_mingw.sh th15`へ委譲した。
- `scripts/105_run_frame_sync.sh <game> <ラベル> <リプレイ> [動画上の秒数]`: ローカルで1本録って集計まで行う。出力は`/mnt/cache3/sattori-<game>-verify/phase105/<ラベル>/`。
- `scripts/105_frame_sync_summary.py <autoplay.log> [区間フレーム数]`: MODログの`stats`行から、上限解除中の処理速度・1フレームの内訳・区間ごとの速度・最終スコアを出す。

### 事前確認: WineからFIFOへ書けるか

Wine 9.0の32bit exeから`CreateFileA("Z:\\tmp\\...\\f.fifo", GENERIC_WRITE, ..., OPEN_EXISTING)`→`WriteFile`でLinuxのFIFOへ書けることを、1280x960x4バイトのフレームで確かめた。読み手が速ければ423fps(2.08GB/s)、読み手を1フレーム20ms遅らせると41.3fpsに落ち、書き込みが正しくブロックした。300フレーム・150フレームとも内容の取り違えなし。

## 1. フル尺の結果

すべてローカル、`--cpu-display`(Xvfb、`LIBGL_ALWAYS_SOFTWARE=1`)、libx264 `veryfast` crf18、`FRAME_SYNC_SKIP_PRESENT`なし、パイプライン化あり(th12 Extraの1本目だけ時計の刻みが1/256)。

```bash
scripts/105_run_frame_sync.sh th15 t2_extra_full th15_08.rpy
SUMMARY_BIN_FRAMES=7200 RUN_TIMEOUT_SEC=5400 scripts/105_run_frame_sync.sh th15 t5_hard_full th15_07.rpy
SUMMARY_BIN_FRAMES=7200 scripts/105_run_frame_sync.sh th12 t3_extra_full th12_05.rpy
SUMMARY_BIN_FRAMES=7200 scripts/105_run_frame_sync.sh th12 t4_hard_full th12_02.rpy
python3 scripts/81_analyze_stutter_periodicity.py <video.mp4> --start 20 --duration <秒> --list-bursts
```

| タイトル | リプレイ | 動画の尺 | 録画の実時間 | 上限解除後の処理速度 | 600フレーム窓の最小/下位5% | フレーム数照合 | スコア(MOD×10 / 記録) | 落ちフレーム | 理論尺との差 |
|---|---|---|---|---|---|---|---|---|---|
| th15 | Extra(`th15_08`) | 797.5秒 | 682.4秒 | **1.17倍速**(70.4fps) | 34.2 / 49.5fps | 47847=47847 | 110347900 / 110347900 | 0(0.0%) | +0.31% |
| th15 | Hard全6面(`th15_07`) | 2039.7秒 | 1364.2秒 | **1.50倍速**(90.0fps) | 66.0 / 74.7fps | 122383=122383 | 417201130 / 417201130 | 1(0.0%) | -0.23% |
| th12 | Extra(`th12_05`)、刻み1/256 | 728.2秒 | 202.6秒 | **3.74倍速**(224.5fps) | 180.8 / 199.1fps | 43695=43695 | 199156770 / 199156770 | 74(0.2%)※ | +0.27% |
| th12 | 同上、刻み1/1024 | 726.4秒 | 217.0秒 | **3.47倍速**(208.2fps) | – | 43583=43583 | 199156770 / 199156770 | 72(0.2%)※ | – |
| th12 | Hard全6面(`th12_02`) | 1728.2秒 | 500.4秒 | **3.50倍速**(210.5fps) | 146.3 / 171.9fps | 103695=103695 | 183240710 / 183240710 | 2(0.0%) | -0.25% |

- 落ちフレームは`scripts/81`(mpdecimate)の値で、この方式では「ゲームが同じ絵を2回`Present`した」ことを意味する(取り込みで落ちることは無い)。
- ※th12 Extraの72〜74フレームは90〜97秒の会話演出に集中している(0.5秒おきに8〜13フレーム)。既存方式(x11grab・等倍)で別のリプレイを録った`/mnt/cache3/sattori-th12-verify/102/seq/area_full.mp4`でも91〜95秒に同じ形(0.5秒おきに5〜13フレーム)が出るので、**会話中に画面が実際に静止する演出**であり、取り込みの問題ではない。刻みを変えても位置・量とも変わらなかった。
- 理論尺との差は「画面静止の始まり(`content_end_video_sec`)−上限解除の時刻」とリプレイの`frameCount/60`の差。上限解除はリプレイ開始のキー操作の約0.8秒後で、静止判定は動画上2秒おきなので、±数秒は測り方の誤差。符号もまちまちで、伸びは無い(この方式では処理落ちで伸びることは原理的に無い)。
- 画面上のfps表示: th15 Extraは「60.0fps」、th12は2本とも200・400・600秒で「60.1fps」。
- 後片付け: 各録画後にwineserver・winedevice・ゲームのプロセスが残っていないことを確認した。

### 区間ごとの処理速度(th15 Extra、3600フレーム=動画1分ごと)

| 区間(分) | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 倍速 | 1.33 | 1.33 | 1.21 | 1.21 | 1.12 | 1.15 | 1.13 | 1.10 | 1.13 | 1.05 | 1.30 | 1.15 | 1.08 | 1.34 |

既存方式の等倍ではこのリプレイの終盤が24.6Hzまで落ちた(reports/99)。この方式では重い場面は遅く進むだけで、600フレーム窓の最小は34.2fps(0.57倍速)だった。

## 2. 既存方式との比較(th15)

| 方式 | 環境 | 動画の尺に対する録画の実時間 | 品質 |
|---|---|---|---|
| 既存・等倍 | `c7i.4xlarge` | ×1.03 | Hard 落ち3.4%で不合格(reports/91) |
| 既存・1/2倍速 | `c7i.4xlarge` | ×2.03 | Hard 落ち0.5%で合格(本番採用、reports/91) |
| 既存・1/3倍速 | Extra(`c7i.2xlarge`で×3.14、reports/91。推奨は`c7i.4xlarge`、reports/98) | ×3.1前後 | Extra 合格 |
| **フレーム同期** | ローカル 8コア16スレッド | **Hard ×0.67、Extra ×0.86** | 落ち0.0%、フレーム数一致 |

ローカル機と`c7i.4xlarge`(16 vCPU)はスレッド数が同じだが、1スレッドの性能やSMTの扱いが違うので、この比は目安。クラウドでの測定が必要。

## 3. 律速の内訳(th15 Extra序盤、動画40秒ぶん)

```bash
FRAME_SYNC_PROBE_READBACK2=1 scripts/105_run_frame_sync.sh th15 p1_readback2 th15_09.rpy 40
FRAME_SYNC_PROBE_NO_READBACK=1 scripts/105_run_frame_sync.sh th15 p3_no_readback th15_09.rpy 40
FRAME_SYNC_PIPELINE=0 FRAME_SYNC_SKIP_PRESENT=1 scripts/105_run_frame_sync.sh th15 p2_skip_present th15_09.rpy 40  # p2はパイプライン化の実装前に実行
scripts/105_run_frame_sync.sh th15 p4_pipeline th15_09.rpy 40
FRAME_SYNC_X264_PRESET=ultrafast scripts/105_run_frame_sync.sh th15 p5_pipeline_ultrafast th15_09.rpy 40
FRAME_SYNC_SKIP_PRESENT=1 scripts/105_run_frame_sync.sh th15 p6_pipeline_skip_present th15_09.rpy 40
```

1フレームの内訳は、game=前の`Present`が戻ってから次の`Present`まで、readback=`GetBackBuffer`〜`LockRect`、write=FIFOへの書き込み、present=本来の`Present`。

| 条件 | 処理速度 | game | readback | write | present |
|---|---|---|---|---|---|
| 逐次(読み出し+`Present`)。p1、診断の2回目の読み出し0.98msを含む | 1.13倍速 | 1.99 | 9.24 | 1.88 | 0.60 |
| 逐次・`Present`省略(p2) | 1.27倍速 | 1.71 | 8.75 | 1.90 | 0.73 |
| パイプライン化(p4、今回の既定) | 1.35倍速 | 1.73 | 6.34 | 3.07 | 1.22 |
| パイプライン化・`Present`省略(p6) | 1.44倍速 | 3.70 | 3.56 | 3.29 | 1.01 |
| パイプライン化・x264 `ultrafast`(p5) | 1.50倍速 | 1.72 | 5.51 | 2.66 | 1.23 |
| 読み出しなし(p3、描画だけの上限) | 1.62倍速 | 1.78 | 0.00 | 1.96 | 6.54 |

読み方:

- **readbackの大半は描画の完了待ち。** 描画が終わった状態での読み出しそのものは0.98ms(1280x960)だった。逐次では`LockRect`がllvmpipeの描画終了まで待つので、その間ゲーム本体が止まる。
- 読み出しをしなくても1.62倍速が上限(このとき待ちは`Present`へ移る)。**th15の律速はreports/99と同じくllvmpipeの塗りつぶし**で、取り込みの仕組みは上限の8割前後(1.35〜1.50倍速)まで来ている。
- `Present`の省略(Xvfbへの転送をやめる)とx264の軽量化はそれぞれ数%〜1割効く。`ultrafast`はファイルが約2倍(40秒で90MB→191MB)になる。
- th12(640x480)は1フレーム4.5〜4.8msで、game(ゲーム本体と描画コールの発行)が3ms前後を占める。

## 4. 未解決・次の作業

- **音声**(必須): reports/104の案A(MOD内の仮想音声デバイス)。まずDirectSoundの呼び出しを記録するプローブで、th15・th12のBGMのストリーミング方式を調べる。
- **クラウド実測**: `c7i.2xlarge`・`c7i.4xlarge`のスポットで同じ4本を測り、既存方式の1/2倍速と費用を比べる。並列2本の上限(AGENTS.md)をこの方式でも守る必要があるかも見る。
- **既定値の見直し**: `FRAME_SYNC_SKIP_PRESENT=1`を既定にするか(フル尺で未確認)。エンコードのプリセット。
- **他タイトルへの展開**: D3D9タイトル(th10・th11・th128・th13・th14・th20)は同じフックで済む見込み。th20はthprac(外部DLL)を使うので時計がIATで届くか要確認。D3D8(th06〜th09)とD3D11(th06nc)は読み出しの実装が別に要る。vpatch(th06・th10)は自前の時計を持つ。
- **GPU描画面**: `gpu_display`のタイトル(th06nc・th15のGPU版)ではXorg+NVIDIAでの読み出し速度が未確認。
- **リプレイ開始前は実時間60Hz**: 起動〜メニュー操作の約10〜15秒は等速で進む(動画の先頭にもその分が入る)。MODのキー操作をフレーム数基準にすれば短縮できる。
- **本番(sattori)への移植**は音声の対応とクラウド実測の後。

## 生成物

- 動画・ログ: `/mnt/cache3/sattori-th15-verify/phase105/`(`t1_extra_short`、`t2_extra_full`、`t5_hard_full`、`p1`〜`p6`)、`/mnt/cache3/sattori-th12-verify/phase105/`(`t3_extra_full`、`t4_hard_full`、`t6_extra_full_step1024`)。各ディレクトリに`run.log`・`<title>_autoplay.log`・`summary.txt`、フル尺は`stutter.txt`
- コード: `mods/common/frame_sync_hook.cpp/.h`(新規)、`mods/common/fps_limiter_hook.cpp`(Presentの前後コールバック)、`mods/th15_replay_autoplay/dllmain.cpp`・`build_mingw.sh`、`mods/th12_replay_autoplay/dllmain.cpp`、`recorder/framesync.py`(新規)、`recorder/options.py`・`cli.py`・`pipeline.py`、`scripts/105_run_frame_sync.sh`・`scripts/105_frame_sync_summary.py`(新規)
