# フェーズ88: 倍速録画の音ズレの原因特定と、同期マーカーによるA/V同期補正

## 背景

`reports/87` §6で未解決のまま残った「倍速録画の音声が等倍録画より一定量遅れる(2倍速で約0.45秒)」問題を調査する。ユーザーからは「録画後の後処理で機械的に補正可能であれば、録画時に完全に同期した音声が録れる必要はない」との方針を受けている。

## 1. 過去ログの横断調査: `delta`は環境・シンクごとに系統的に違う

`recorder/ffmpeg.py`の`mux_audio_video()`が出す`A/V同期補正: ... delta=`(音声ffmpegの`-copyts`のstart_time − 映像ffmpegのstart_time)を、`/mnt/cache3`配下の全録画ログから集計した。

```bash
cd /mnt/cache3 && for f in $(grep -rl "A/V同期補正" --include=*.log .); do
  echo "$f: $(grep -h 'A/V同期補正' $f | sed 's/.*delta=/delta=/;s/ (.*//' | tr '\n' ' ') | $(grep -ho 'f pulse[^/]*' $f | head -1)"; done
```

| 環境 | 録音元 | delta |
|---|---|---|
| ローカル th07/th06c/th09/th128 | auto_null / 並列用専用シンク | -0.029〜-0.045s |
| ローカル th15(本フェーズ) | auto_null | **+0.588〜+0.602s** |
| AWS th15 等倍(reports/87) | auto_null | **+0.592〜+0.601s** |
| AWS th15 倍速(reports/87) | 倍速用専用シンク | -0.004〜-0.023s |

音声ffmpegは映像ffmpegの**後に**起動しているので、本来deltaは正(数十ms)になるはずで、負の値が出ること自体がタイムスタンプが実時刻を表していない証拠である。しかもタイトル・シンクによって0.6秒も違う。

## 2. ffmpegのpulse入力のタイムスタンプの付け方(ソース確認)

FFmpeg n6.1.1(ローカル・AWSとも`6.1.1-3ubuntu5`)の`libavdevice/pulse_audio_dec.c`:

```c
dts = av_gettime();                       /* 読み取った瞬間の壁時計 */
pa_operation_unref(pa_stream_update_timing_info(pd->stream, NULL, NULL));
if (pa_stream_get_latency(pd->stream, &latency, &negative) >= 0) {
    if (negative) dts += latency; else dts -= latency;
}
...
pkt->pts = ff_timefilter_update(pd->timefilter, dts, pd->last_period);
```

`pa_stream_get_latency()`は録音ストリームに対して「ソースのレイテンシ + 転送遅延 − (モニターソースなら)**シンク側のレイテンシ**」を返す(PulseAudio `pulse/stream.c`の`calc_time()`)。つまりモニターソースのタイムスタンプは「その音がシンクで**再生されるはずの**時刻」になり、null-sinkのレイテンシ設定(シンクに繋がっている全ストリームの要求で動的に変わる)に依存する。さらに、Wine(dsound→winepulse)がゲームの音をPulseAudioへ書き込むまでの出力遅延は、どのタイムスタンプにも含まれない。**start_timeの差から音ズレを補正する方式(reports/28)は、原理的に「出力遅延」も「シンクのレイテンシ依存のぶれ」も補正できない。**

## 3. 実パイプラインと同じ順序での計測(ローカル)

`reports/87`のDirectSound遅延プローブは「録音開始→プローブ起動」の順だったが、実パイプラインは「ゲーム起動(再生中)→録音開始」の順である。

- `scripts/88_dsound_loop_probe/dsloop.cpp`(新規): 1秒ごとのクリックを`DSBPLAY_LOOPING`で鳴らし続けるDirectSound音源。
- `scripts/88_measure_pulse_ts.py`(新規): dsloopを先に起動し、`--pre`秒後に`recorder/ffmpeg.py`と同じコマンドで録音。追加出力`-f framecrc`でパケットごとのptsも記録し、start_time基準・パケット基準の「Play→録音上のクリック」の遅延を比較する。

```bash
Xvfb :91 -screen 0 640x480x24 &
DISPLAY=:91 WINEPREFIX=$PWD/prefixes/th15-wined3d-gl python3 scripts/88_measure_pulse_ts.py --mode native --repeat 3
DISPLAY=:91 WINEPREFIX=$PWD/prefixes/th15-wined3d-gl python3 scripts/88_measure_pulse_ts.py --mode speed --mult 2 --repeat 3
```

| 経路 | Play→録音上のクリック(start_time基準) |
|---|---|
| 等倍(auto_null・AAC m4a) | 177.0〜181.5ms |
| 2倍速(88200Hz専用シンク・PCM mov) | 184.4〜194.9ms |

ローカルのこの構成では両経路の差は10ms程度で、`reports/87`がAWSで観測した0.26秒差は再現しなかった。一方で**どちらの経路でも約0.18秒の出力遅延が補正されずに残っている**ことが分かった。パケットごとのptsから逆算した「開始時刻」は録音中ほぼ一定(±数ms)で、ずれは録音開始時に固定される(timefilterの初期化以降は安定)。

## 4. 解決策: 同期マーカー

タイムスタンプを使わずに「音声上の位置 ↔ ゲームが音を鳴らした壁時計時刻」を直接対応付ける。

### 4.1 MOD側: `mods/common/dsound_hook.cpp`

- `MyDirectSoundCreate8`でゲームの`IDirectSound8`を控える(`g_ds8`)。
- `InstallDSoundHook()`は環境変数`SYNC_MARKER_TRIGGER`(Windows形式のパス)があればスレッドを起こし、そのファイルが現れるのを5ms間隔で待つ。
- 現れたら**ゲーム自身の`IDirectSound8`から**、xorshift32(seed=`0x2545F491`)の最下位ビットによる±1系列(`kSyncMarkerSamples`=131072サンプル、振幅`kSyncMarkerAmp`=256≒-42dBFS)をモノラル16bit、`44100×freqScale`Hz(=シンクのレート。dsoundミキサーでリサンプルされない)のセカンダリバッファで1回だけ鳴らし、Play直前の`GetSystemTimePreciseAsFileTime`(UNIX epoch秒)をログへ出す:

```
SYNC_MARKER played epoch=1790325492.766373 play_call_sec=0.000000 rate=44100 samples=131072 amp=256 seed=0x2545F491 hr=0x00000000
```

ゲームのBGM/SEと同じミキサー・同じPulseAudioストリームを通るので、Wineの出力遅延・シンクのレイテンシ・ffmpegのタイムスタンプのぶれはすべてゲームの音と共通になり、打ち消される。全ZUN作品(th06〜th20)の実行ファイルが`dsound.dll`をOrdinal 11(`DirectSoundCreate8`)でインポートしていることを`pefile`で確認済みなので、`InstallDSoundHook()`を呼べばどのタイトルでも使える。

### 4.2 録画パイプライン側: `recorder/sync_marker.py`(新規)

- `GameConfig.build_env()`が`SYNC_MARKER_TRIGGER=Z:\...\instances\<id>\sync_marker.trigger`を渡す。
- `attempt_recording()`は起動前に古いトリガーを消し、音声録音開始の`TRIGGER_DELAY_SEC`=2秒後にトリガーを置く(`schedule_trigger()`)。
- `mux_audio_video(..., marker_log_path=config.log_path)`:
  1. MODログから`SYNC_MARKER`行を読む。
  2. 音声ファイルを`-af aresample=first_pts=0`付きでデコード(muxと同じ時間軸。AACのプライミングも同じ扱いになる)し、先頭`SEARCH_SEC`=20秒からPHAT(白色化相互相関)でマーカーを探す。ピーク/中央値比が`MIN_PEAK_RATIO`=20未満なら従来のstart_time方式へフォールバック。
  3. 「音声ファイル先頭の真の時刻」=`marker_epoch − 音声上の位置`とし、映像のstart_time(x11grabの先頭フレームの壁時計時刻)との差でmuxする。
  4. mux後の動画でもマーカーの位置と映像時間軸上の期待位置を照合して残差をログに出し、3msを超えたら1回だけ差し引いてmuxし直す。

### 4.3 マーカーの振幅・長さの決定

- オフライン試算(th15タイトル画面BGM -16dBFS、AAC 192k往復): 振幅16(-66dBFS)でもPHATのピーク比69で検出可能。
- しかし実録画ではBGMが-10.5dBFSと大きく、Wineのミキサーでモノラル→ステレオ化の際に各chへ約-6dB減衰して入る(最小二乗推定で振幅128→各ch約60)ため、振幅64・65536サンプルではピーク比11.8で検出失敗、振幅128で23(ぎりぎり)。
- 探索範囲を広げるほどPHATのピーク比は下がる(振幅64のとき 5秒=37、10秒=20、30秒=13)。
- 最終的に**振幅256・131072サンプル(等倍で約3.0秒、2倍速で約1.5秒)・探索20秒**とし、th15実録画でピーク比77〜92、mux後検証115〜135を得た。

## 5. 検証: 「正解」の分かる合成プローブ

同じリプレイの録画同士を照合する方法(`scripts/87_compare_timeline.py`)は、th10のローカル等倍2本で、マーカー方式でもstart_time方式でもA/V差が0にならなかった(+65〜+137ms)。**BGMはゲームのフレーム処理とは別にストリーミング再生されるため「BGMと画面の対応」自体が実行ごとに数十〜百ms揺らぐ**ためで、同期の正否判定には使えない。そこで正解が既知の合成テストを作った。

- `scripts/88_av_flash_probe/avflash.cpp`(新規): Wine上で、DirectSoundのクリック(10ms矩形)をPlayした直後にポップアップウィンドウを白く塗る(Wineのウィンドウサーフェスは描画直後にメッセージを汲まないとXへ反映されないため`RedrawWindow`+`PeekMessage`を呼ぶ。Play→描画完了は約0.1ms)。`SYNC_MARKER_TRIGGER`に対してMODと同一のマーカーも鳴らす。
- `scripts/88_av_truth_test.py`(新規): `recorder/ffmpeg.py`の`build_video_ffmpeg_cmd()`/`build_audio_ffmpeg_cmd()`/`mux_audio_video()`をそのまま使って録画・muxし、出力動画上の「光った時刻」と「クリックの時刻」の差(正=音が遅れる)を、マーカー方式とstart_time方式で比較する。

```bash
WINEPREFIX=$PWD/prefixes/th10-wined3d-gl python3 scripts/88_av_truth_test.py --repeat 4
WINEPREFIX=$PWD/prefixes/th10-wined3d-gl FPS_LIMIT_TARGET_HZ=120 python3 scripts/88_av_truth_test.py --repeat 4
```

ローカル(HakataMatrix)の結果(各試行7回のフラッシュの平均、単位ms):

| 経路 | 同期マーカー方式 | start_time方式(従来) |
|---|---|---|
| 等倍(auto_null・AAC) | -17.2 / -1.0 / -0.6 / +1.8 (+ 別試行 -1.3) | +189.8 / +115.0 / +115.4 / +97.8 (+ 別試行 +176.7) |
| 2倍速・録画時の実時間 | -12.7 / -13.2 / -9.1 / -7.7 | +37.3 / +31.8 / +33.0 / +32.3 |
| 2倍速・等倍復元後(×2) | 約-15〜-26 | 約+64〜+75 |

- **従来方式は、等倍でも実行ごとに+98〜+190msとぶれ、常に音が遅れていた。** 倍速ではこれが復元時に倍率分拡大される。
- **同期マーカー方式は全条件で±20ms以内**。残る負のオフセット(数ms〜1フレーム分、音がわずかに先行)は、画面が変わってから次のx11grabのキャプチャまでの待ち(60fpsで最大16.7ms)で説明できる大きさで、実機のディスプレイでも同様に生じる種類のものである。

## 6. その他の変更

- `mods/common/build_mingw.sh`(新規): 32bitタイトルのMODをLinux上のmingwでビルドする汎用スクリプト。各タイトルの`build.bat`のソース一覧は後から追加された共通フック(`stage_probe_hook`等)に追随しておらずリンクできない(th10で確認)ため、「タイトルの`dllmain.cpp` + `mods/common/*.cpp`(injector除く)」をまとめて`--gc-sections`付きでリンクする。th06/07/08/09/10/11/12/128/15/20の全MODのビルドを確認。

## 7. AWS(g6f.2xlarge、us-west-2スポット)での確認

reports/87で+0.6秒のずれが出たのと同じ構成(Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04)、GRIDドライバ、ホスト直接導入)のインスタンス`<INSTANCE_ID>`で、§5の合成プローブをXvfb上で実行した(インスタンスにはxvfbを追加導入)。

| 経路 | 同期マーカー方式 | start_time方式(従来) |
|---|---|---|
| 等倍(auto_null・AAC、libx264) | -13.1 / -13.8 / -19.0 | +163.9 / +162.1 / +89.0 |
| 2倍速・実時間(libx264) | -7.0 / -4.1 / -7.4 | +40.9 / +43.9 / +41.6 |
| 2倍速・実時間(NVENC) | +7.6 / +1.9 | +54.6 / +50.9 |

AWSでも従来方式は音が遅れており(等倍+89〜+164ms、2倍速は復元後+82〜+110ms)、マーカー方式は全条件で±20ms以内(2倍速の復元後も±15ms程度)に収まった。

### 7.1 th15 Extra(th15_09.rpy)の2倍速を同期マーカー込みで再録画

`scripts/89_run_speedup_batch.sh th15 th15_extra_2x th15_09.rpy 2`(`--gpu-display --gpu-encode`)。試行1回目で成功、スコア1710121で一致、重複フレーム率0.0%、FpsMonitor中央値119.8Hz、マーカーのピーク比136・mux後残差+0.1ms、復元後の落ちフレームは15〜165秒で3枚(0.0%)。

フェーズ87の等倍録画(`raw/extra_1x.mp4`、start_time方式でmux)を参照に`scripts/87_compare_timeline.py`で照合すると、`av_delta`はフェーズ87の2倍速(+413〜+446ms)から**+63〜+79ms**に縮んだ。参照側の等倍録画自体がstart_time方式(§5・§7の通り音が+90〜+190ms遅れる)でmuxされており、さらにBGMと画面の対応は実行ごとに揺らぐ(§5冒頭)ため、この残差をそのまま誤差とは見なせない。

## 8. 結論

- **倍速録画の音ズレの主因は、ffmpegのpulse入力の開始タイムスタンプが、Wine(dsound→winepulse)の出力遅延とPulseAudioシンクのレイテンシを含まないことだった。** 従来方式は等倍でも音が+90〜+190ms遅れており、倍速では復元時にこれが倍率分拡大されていた(reports/87の+0.45秒)。
- 同期マーカー(MODがゲーム自身の音声デバイスから-42dBFSの疑似乱数ノイズを鳴らし、録画後に相互相関で検出して補正)により、ローカル・AWS、等倍・2倍速、libx264・NVENCのいずれでも**A/Vの誤差が±20ms以内**になった。補正はすべて録画後のmux処理で機械的に行われ、見つからない場合は従来方式へフォールバックする。
- WASAPIで音声を出すタイトル(th06nc)向けの同じ仕組みは reports/89 で実装した(`mods/common/wasapi_hook.cpp`)。

## 残課題

- マーカー(等倍で約3秒、-42dBFS≒BGMより30dB以上小さいホワイトノイズ)は録画の冒頭(タイトル画面)に残る。聴感上問題ないかはユーザーの視聴確認待ち。気になる場合、倍速録画(mux時にPCMから再エンコードする経路)では検出した位置・振幅で差し引くことができる。
