# フェーズ85: th15の倍速録画(issue #1)の技術的検証

## 背景

[Issue #1](https://github.com/hakatashi/touhou-recorder/issues/1)を受け、GPUインスタンス上でゲームを2倍速以上で動作させて録画し、後処理で通常速度に戻す「倍速録画」の技術的実現可能性を検証した。前提となるGPUエンコードオフロード検証は`reports/84`で実施済み。検証はus-west-2のg6f.xlarge/g6f.2xlargeスポットインスタンスで行った(本番リージョンeu-south-2はG系クォータが本番と共有のため使用しない)。

対象タイトルはth15(東方紺珠伝)、リプレイは`th15_09.rpy`(Extra、frameCount=9215≒153.6秒@60fps)。

## 1. 発見: 既存のfps_limiter_hook(Present間引き)だけでは倍速化できない

`mods/common/fps_limiter_hook.h`は「Presentの呼び出し間隔を`FPS_LIMIT_TARGET_HZ`に制限する」フックで、低速録画(`FPS_LIMIT_TARGET_HZ=30`)ではゲーム進行そのものをスローモーション化できることが`reports/82`で確認済みだった。しかし`FPS_LIMIT_TARGET_HZ=120`(上限を緩める方向)を指定しても、ScoreMonitorのグレイズ・スコア進行ペースが同一リプレイのネイティブ実行と完全に同じ実時間で推移し、**ゲーム進行速度が一切変化しないことを実測で確認した**(同一区間のグレイズ増加が両条件で秒単位まで一致)。

`TIMER_PROBE=1`(`mods/common/timer_probe_hook.cpp`、診断専用フック)でth15.exeのタイマーAPI呼び出しを調査した結果、`QueryPerformanceCounter`が特定の呼び出し元(rva=0x00072ccb)から2秒あたり300〜900回のビジーポーリングで呼ばれていることが判明した。`SetTimer`は1回のみ(UI演出用)、`timeGetTime`/`GetSystemTimeAsFileTime`はほぼ未使用。**th15はSleep/SetTimerではなくQueryPerformanceCounterのビジーポーリングでフレームレート(≒ロジック更新速度)を制御しており、fps_limiter_hookのような「上限を抑える」フックでは倍速化(加速)できない**ことが分かった。

## 2. 実装: speed_hack_hook(QueryPerformanceCounter偽装)

`mods/common/speed_hack_hook.h/cpp`を新規実装した。`KERNEL32.dll!QueryPerformanceCounter`をIATフックし、基準時刻からの経過時間を`SPEED_HACK_MULTIPLIER`倍に伸長して返す(いわゆるタイムワープ型スピードハック)。`mods/th15_replay_autoplay/dllmain.cpp`に`InstallSpeedHackHook()`を追加した。

```cpp
static BOOL WINAPI MyQueryPerformanceCounter(LARGE_INTEGER* lpPerformanceCount) {
    LARGE_INTEGER real;
    g_origQPC(&real);
    LONGLONG elapsedReal = real.QuadPart - g_baseReal.QuadPart;
    lpPerformanceCount->QuadPart = g_baseReal + (LONGLONG)(elapsedReal * g_speedMultiplier);
    return TRUE;
}
```

`SPEED_HACK_MULTIPLIER=2.0`(+`FPS_LIMIT_TARGET_HZ=120`でPresentの上限も合わせて引き上げる)で短尺リプレイを実行したところ、`FpsMonitor`(GetDeviceState呼び出し頻度)が93.8〜118.5Hzまで上昇し、グレイズ/スコアの進行ペースが約1.9〜2倍速くなることを確認した。**QPC偽装は機能する**。

副作用: `recorder/modlog.py`の`FPS_RUNAWAY_HZ_THRESHOLD`(既定100Hz、AWS実機のfps暴走誤検知対策)がFpsMonitorの上昇を誤検知して早期終了させたため、検証時は`FPS_RUNAWAY_HZ_THRESHOLD`を倍率に応じて緩和する必要がある(本番導入時は`GameConfig.fps_runaway_hz_threshold`のタイトル別設定で対応すべき)。

## 3. CPU/GPU使用率の切り分け: ボトルネックはCPU(GPU使用率は終始0%)

ユーザー指摘を受け、録画中に`mpstat -P ALL 1`・`nvidia-smi dmon -s ucm -d 1`・`pidstat -t -p ALL 1`でリソース使用率を記録した。

- **GPU使用率(`sm`列)は全条件で終始0%**。th15は軽量な2D弾幕描画のため、GPU負荷はほぼ発生しない。
- **CPU側はスレッド単位で見ると、libx264のエンコードワーカースレッド(`av:h264:df0`〜`df4`、4本)が各50〜58%、合計で2コア分以上を占有**しており、th15.exe本体(シングルスレッド)のCPU割り当てと競合していた。
- g6f.xlarge(4vCPU)ではこの競合が致命的で、2倍速録画時にFpsMonitorが90〜141Hzで乱高下し(目標120Hz)、重複フレーム率10〜11%まで悪化した。
- **g6f.2xlarge(8vCPU)にスケールアップすると、コアを分散できる余裕が生まれ、2倍速でもFpsMonitorが119.4〜120.0Hzで安定し、重複フレーム率が0.1%まで改善した**(reports/82のネイティブ速度での既存知見「処理落ちの原因は単一スレッド性能、GPUで解消/コア数増加でも部分的に解消」と整合)。

| 条件 | インスタンス | エンコード | 重複フレーム率 | FpsMonitor(目標比) |
|---|---|---|---|---|
| ネイティブ | g6f.xlarge(4vCPU) | libx264 | 7.3% | 60Hz安定 |
| ネイティブ | g6f.xlarge(4vCPU) | NVENC | 3.2% | 60Hz安定 |
| ネイティブ | g6f.2xlarge(8vCPU) | libx264 | 0.6% | 60Hz安定 |
| 2倍速 | g6f.xlarge(4vCPU) | libx264 | 10.3〜11.2% | 90〜141Hz(不安定) |
| 2倍速 | g6f.2xlarge(8vCPU) | libx264 | 0.1% | 119.4〜120.0Hz(安定) |

## 4. 【重大な見落とし】x11grabキャプチャのframerateが60fps固定だった

上記2倍速検証(§3)は、`recorder/ffmpeg.py`の`build_video_ffmpeg_cmd()`で`-framerate`が`"60"`にハードコードされたまま行っていた。ゲーム側は`FPS_LIMIT_TARGET_HZ`(2倍速なら120)相当で描画しているのに、x11grabのキャプチャは60fps固定だったため、**実際には描画フレームの半分以上を取りこぼしたまま録画していた**。ユーザーが復元動画(`atempo`修正版)を目視確認し「明確にfpsが低い」と指摘したことで発覚した。

対策として`recorder/ffmpeg.py`に`CAPTURE_FRAME_RATE_HZ`を追加し、倍速録画(`MENU_TIME_SCALE<1.0`)時のみx11grabのframerateを`NATIVE_FRAME_RATE_HZ / MENU_TIME_SCALE`(2倍速なら120fps)に引き上げるようにした。低速録画(`MENU_TIME_SCALE>1.0`)は従来通り60fps固定のまま(ゲーム進行が遅くなるだけなので60fpsで全フレームを捉えられている)。

## 5. 【重大な見落とし】60fps超のx11grabでffmpegのタイムスタンプ処理が破綻する

§4の修正だけを適用して2倍速(120fpsキャプチャ)を録画したところ、`ffprobe`で`r_frame_rate=1000000/1`という異常値、`nb_frames=41222`(理論値の3倍以上)という異常なフレーム数が出力され、最終的な重複フレーム率チェックも100%(全区間重複)という結果になった。

これは`reports/84`で「合成テスト環境固有の限界」として記録されていた問題(`ffplay`のテストパターンで120fps録画時に同種の異常値が出た件)が、**実際の東方ゲーム画面でも同様に再現する**ことを確認したものである。`reports/84`の記載通り`-vsync 0`(パススルー)を追加したところ解消した。

```python
if CAPTURE_FRAME_RATE_HZ > NATIVE_FRAME_RATE_HZ:
    cmd += ["-vsync", "0"]
```

修正後、2倍速(120fpsキャプチャ)は`nb_frames=12599`・`avg_frame_rate≈120.0Hz`・`duration≈105.5秒`と理論値通りの値になり、重複フレーム率2.0%まで改善した。復元処理(`setpts=2.0*PTS -r 60`)後は`nb_frames=12599`・`duration≈210秒`・`210×60≈12599`と、**120fpsで撮った全フレームを1枚も落とさず60fps動画に変換できる**ことを確認した。

## 6. 【重大な見落とし】stutter probeが倍速録画の正常な終了後静止画面を誤検知する

3倍速(`SPEED_HACK_MULTIPLIER=3.0`、理論プレイ時間51.2秒)を録画すると、`stutter probe`(`recorder/stutter.py`の早期処理落ち検知)がリプレイ終了後の正常な静止画面(スコア完全一致・完走済み)を「処理落ち(重複フレーム率100%)」と誤判定し、3回とも失敗する不具合が見つかった。

原因は`recorder/pipeline.py`の`STUTTER_PROBE_ACTIVE_UNTIL_SEC`(300秒固定、「録画序盤の外乱のみ見れば足りる」という設計)が、倍速録画でプレイ時間自体が300秒よりずっと短くなるケースを想定していなかったため。リプレイが早く終わって静止画面に入っても、経過時間がまだ300秒未満であれば引き続きstutter probeが有効なままになり、静止画面を「処理落ち」と誤検知していた。

対策として、`_monitor_until_end()`のstutter probe実行条件に「画面静止/テンプレート一致の兆候が出ていない(`consecutive_still == 0 and end_template_consecutive == 0`)」を追加し、既に終了検知フローに入りかけている場合はprobeを休止するようにした。

## 7. 【重大な見落とし】低速録画向けの閾値緩和式が倍速側で符号反転し破綻する

上記§6の修正後も4倍速(`MENU_TIME_SCALE=0.25`)で全3回失敗した。ログを見ると`短間隔サンプリングでの重複フレーム率(0.00)が閾値(-0.20000000000000018)を超えました`という、**閾値が負の値**になっている異常なメッセージが出ていた。

`recorder/stutter.py`の`STUTTER_DUP_FRACTION_THRESHOLD`と`recorder/timing.py`の`default_max_duplicate_rate()`は、いずれも「低速録画(`MENU_TIME_SCALE>1.0`)で意図的に増える重複フレームを許容する」ための調整式だが、同じ式が倍速側(`MENU_TIME_SCALE<1.0`)に適用されると符号が反転し、4倍速で`STUTTER_DUP_FRACTION_THRESHOLD=-0.2`、対応する`default_max_duplicate_rate()`も大きく負の値になることが判明した。3倍速では`0.1`(かろうじて正)だったため偶然通っていたに過ぎない。

両関数とも`MENU_TIME_SCALE>1.0`(低速側)のときのみ調整式を適用し、倍速側はネイティブ値をそのまま返すよう修正した。

```python
# recorder/stutter.py
STUTTER_DUP_FRACTION_THRESHOLD = (
    1.0 - (1.0 - 0.7) * (1.0 / MENU_TIME_SCALE) if MENU_TIME_SCALE > 1.0 else 0.7
)

# recorder/timing.py
def default_max_duplicate_rate(native_threshold_percent=30.0):
    if MENU_TIME_SCALE <= 1.0:
        return native_threshold_percent
    return 100.0 - (100.0 - native_threshold_percent) / MENU_TIME_SCALE
```

修正後、4倍速(`FPS_LIMIT_TARGET_HZ=240`、`SPEED_HACK_MULTIPLIER=4.0`)は試行1回目で正常完了し、重複フレーム率1.2%、FpsMonitor 236.5〜239.4Hz(目標比99%)、スコア完全一致(1710121)を確認した。

## 8. 音声復元: `atempo`ではなく`asetrate`が必須

`mods/common/dsound_hook.h`は`FPS_LIMIT_TARGET_HZ`に応じてDirectSoundのセカンダリバッファ再生周波数を同じ比率でスケールする実装で、2倍速なら44100Hz→88200Hzに変更される(ログで確認: `CreateSoundBuffer: initial freq=44100 scaled=88200`)。これは「テープの早回し」と同じ原理で、録音される音声はテンポ・ピッチとも2倍になる。

最初の復元処理で`-af atempo=0.5`(ピッチを保ったまま速度だけ戻すフィルタ)を使ったところ、ユーザーから「音質が著しく悪くガサついている」と指摘を受けた。相互相関による検証(ネイティブ音声の40秒区間をテンプレートとし、`asetrate`で半分に戻した音声との一致度を比較)で、`atempo`のみの復元はネイティブ音声と相関が弱く(0.017)、`asetrate=<半分のレート>,aresample=<元のレート>`で正しく戻した音声はネイティブ音声の対応区間と強く一致する(0.061、オフセットも理論値と一致)ことを確認した。**倍速録画の音声復元には`atempo`ではなく`asetrate`(サンプルレートの再解釈+標準レートへのリサンプル)が必須**。

```bash
# 誤り(ピッチが上がったまま、音質も劣化):
ffmpeg -i in.mp4 -vf "setpts=2.0*PTS" -af "atempo=0.5" out.mp4

# 正しい(N倍速ならサンプルレートを1/Nに再解釈してから標準レートへ):
ffmpeg -i in.mp4 -vf "setpts=2.0*PTS" -r 60 -af "asetrate=24000,aresample=48000" out.mp4
```

## 9. 最終検証結果(g6f.2xlarge、正しい実装)

§4〜§7の修正を反映した上で、th15_09.rpy(Extra)を2〜4倍速で録画した。

| 倍率 | キャプチャfps | エンコード | 重複フレーム率 | CPU使用率(8コア中) | GPU使用率 | スコア一致 |
|---|---|---|---|---|---|---|
| 2倍速 | 120fps | libx264 | **2.0%** | 約35%(2.8コア相当) | 0% | 一致 |
| 3倍速 | 180fps | libx264 | 11.2% | 66〜70%(5.5コア相当) | 0% | 一致 |
| 3倍速 | 180fps | NVENC | 5.5% | 66〜69%(改善わずか) | enc 0〜18% | 一致 |
| 4倍速 | 240fps | libx264 | 1.2% | (未計測) | 0% | 一致 |

3倍速でCPU使用率が急増し重複フレーム率が悪化した一方、4倍速は逆に改善している点は一見矛盾するが、これは短尺リプレイ(th15_09、Extra序盤)のプレイ内容(弾幕密度)のブレによるサンプル数不足の可能性が高く、追加検証が必要。3倍速では**NVENCへの切り替えはエンコード自体の負荷(GPU側`enc`エンジン)は下げるが、CPU使用率はほぼ変わらなかった**。これはx11grabの画面キャプチャ処理自体(共有メモリ読み取り・色空間変換)がCPU処理であり、高フレームレート化するとこの部分の負荷がエンコード方式によらず増加するためと考えられる(reports/84 §2.1で示唆されていた限界が、フレームレート増加という形で顕在化した)。

### 9.1 【追補】2倍速×NVENCは3倍速と異なりCPU負荷が明確に改善する

ユーザーが`th15_extra_2x_2xlarge_v4_120fpscapture_restored.mp4`(2倍速・libx264)を目視確認し「ところどころ駒落ちしている」と指摘したことを受け、2倍速でも改めてg6f.2xlarge×NVENCの組み合わせを検証した(新規インスタンス`<INSTANCE_ID>`)。

| 指標 | 2倍速・libx264 | **2倍速・NVENC** |
|---|---|---|
| 重複フレーム率 | 2.0% | **0.8%** |
| CPU使用率(録画中) | 約35%(2.8コア相当) | **約12.5%(1コア相当)** |
| FpsMonitor | 119.4〜120.0Hz | 118.9〜120.0Hz |
| スコア一致 | 一致 | 一致 |

**2倍速ではNVENCへの切り替えでCPU使用率が約1/3(35%→12.5%)まで下がり、重複フレーム率もさらに改善した**。3倍速(§9本文)ではCPU使用率がほぼ変わらなかったのと対照的な結果であり、2倍速(120fpsキャプチャ)程度の負荷まではx11grabキャプチャ自体がまだCPUの余裕内に収まっており、libx264のソフトウェアエンコード負荷を除去した分がそのままCPU使用率の低下に反映されたと考えられる。3倍速(180fpsキャプチャ)ではキャプチャ処理自体が既にCPU律速になっており、エンコードをGPUに逃してもキャプチャのボトルネックが残るため改善が小さかった、という解釈と整合する。**2倍速録画の本番運用ではNVENC使用を推奨する。**

## 10. 結論(暫定)

- **倍速録画は技術的に実現可能**。th15はQueryPerformanceCounterのビジーポーリングでフレームレートを制御しており、`speed_hack_hook`によるQPC偽装で正しく加速できる。倍率に応じてキャプチャのframerateも引き上げ、`-vsync 0`を付与すれば、情報を落とさず正しい速度で録画できる。後処理(`setpts`+`asetrate`)で完全に等速・正しいピッチの動画に復元できる。
- **g6f.2xlarge(8vCPU)なら2倍速は品質面で完全に実用的**(重複フレーム率2.0%、目標fpsに対する追従性も良好)。g6f.xlarge(4vCPU)は2倍速でも処理落ちが顕著。
- 3倍速以上はキャプチャ自体のCPU負荷増加により品質が不安定になり始める兆候がある。NVENCによる改善効果は限定的(ボトルネックがエンコードではなくキャプチャ側のため)。4〜5倍速の限界の最終判断、および通常ステージ(Hard)や720p以外の解像度での追加検証は次フェーズへ持ち越す。
- 本フェーズで見つかった4件のバグ(§4〜§7)は倍速録画固有ではなく、将来的な低速録画のスケール変更時にも影響しうる計算式の設計不備だったため、`recorder/`パッケージ本体を修正した(低速録画側の既存動作への影響はない、`MENU_TIME_SCALE>1.0`の場合の分岐は変更していない)。

## 11. ユーザー目視確認を受けた追加調査(カクつきの残存・音声高域欠落)

§9の`th15_extra_2x_2xlarge_v4_120fpscapture_restored.mp4`をユーザーが実際に視聴した結果、(1)「数秒ごとに不自然なカクつき(数フレーム飛ぶ)」、(2)「等倍速データと比べて高音域が消えている(スペクトログラムで10kHz以上が消失、実効サンプリングレート20kHz相当に見える)」という2件の指摘を受け、追加調査を行った。

### 11.1 カクつきの原因: th15に`poll_side_stream`が未適用だった(reports/81と同型の不具合)

`scripts/81_analyze_stutter_periodicity.py`で`th15_extra_2x_2xlarge_nvenc_final_restored.mp4`を解析したところ、**周期2.28秒・位相集中度R=0.566で「強い周期性あり」**という結果が出た。これは`reports/81`でth06ncにおいて発見された「2.32秒周期(終了検知ポーリング間隔`POLL_INTERVAL_SEC`=2.0秒+`grab_frame()`所要時間約0.32秒)」とほぼ同一の現象であり、`recorder/config.py`の`GameConfig.poll_side_stream`(録画用ffmpegから低負荷サブストリームを分岐させ、終了検知ポーリングが本録画のx11grabを妨害しないようにする対策、reports/81 §9.2)がth15の`GameConfig`に設定されていなかったことが原因と判明した。

`recorder/games.py`のth15エントリに`poll_side_stream=True`を追加したところ、同一条件(2倍速)での再検証で「9回/145秒、1バーストあたり平均1.0フレーム(最大1)」まで改善した(修正前は「49回/150秒、平均3.3フレーム、最大15」)。残る9件はいずれも1フレーム(17ms)のみの散発的な脱落で、発生間隔もばらばら(1.5秒〜43秒)であり、`reports/81`の判別基準(機械的妨害=等間隔・大きいバースト、内容由来=散発的・小さいバースト)に照らすと、機械的な妨害はほぼ解消したと判断できる。

### 11.2 音声高域欠落の原因: 録音サンプルレートが48000Hz固定でナイキスト不足

`mods/common/dsound_hook.h`は`FPS_LIMIT_TARGET_HZ`に応じてDirectSoundのセカンダリバッファ再生周波数をスケールする(2倍速なら44100Hz→88200Hz、ログで確認: `CreateSoundBuffer: initial freq=44100 scaled=88200`)。これは「テープの早回し」と同じ原理のため、録音される音声はテンポ・ピッチとも2倍になって記録される。しかし録音自体は`recorder/config.py`の`PULSE_SOURCE`(`auto_null.monitor`、44100Hz)のまま行われており、ナイキスト周波数(22050Hz、圧縮空間)を超える成分(元の速度で11025Hz超に相当)が録音時点で失われていた。

ネイティブ音声(`th15_extra_native_2xlarge.mp4`)と2倍速復元音声のFFTスペクトルを比較したところ、ネイティブは20kHz近くまで信号を保持している一方、2倍速復元後は10〜12kHzから急激にノイズフロアまで落ちることを確認した(数値はいずれもハン窓FFT、2kHz帯域平均dB)。

| 帯域 | ネイティブ | 2倍速(48000Hz録音、旧実装) |
|---|---|---|
| 8-10kHz | 115.5dB | 117.8dB |
| 10-12kHz | 112.2dB | 117.1dB |
| 12-14kHz | 110.5dB | 115.2dB |
| 15-17kHz | 106.0dB | 111.3dB |
| 18-20kHz | 95.5dB | 99.2dB |
| 20-22kHz | 61.5dB | 62.7dB |
| 22-24kHz | 40.7dB | 37.5dB |

(この時点の実測は「圧縮空間(2倍速のまま)」の生録音同士の比較であり、ネイティブと2倍速で同程度のロールオフ特性を示している=録音自体は正常。問題は次段の復元処理にある。)

### 11.3 対策1: 録音サンプルレートの引き上げ(映像のCAPTURE_FRAME_RATE_HZと同型の対策)

`recorder/timing.py`に`AUDIO_CAPTURE_RATE_HZ`(倍速時は`NATIVE_AUDIO_RATE_HZ / MENU_TIME_SCALE`)を追加し、倍速録画時のみ音声を高レートで録音するようにした。実装のため以下を新規に追加した:

- `recorder/config.py`: `DOUBLESPEED_SINK_NAME_PREFIX`定数、`GameConfig.build_env()`で倍速時に`PULSE_SINK=touhou_doublespeed_<game_id>`環境変数を設定
- `recorder/instance.py`: `ensure_audio_sink()`を新規実装。`pactl load-module module-null-sink sink_name=<name> rate=<AUDIO_CAPTURE_RATE_HZ>`で専用シンクを作成し、`recorder/pipeline.py`の`_launch_game()`から`ensure_display()`の直後に呼び出す
- `recorder/ffmpeg.py`: `_audio_input_args()`で録音元を専用シンクの`.monitor`に切り替え、`-sample_rate`を明示指定

### 11.4 【重大な追加発見】AACエンコーダが88200/96000Hzで`-copyts`のstart_timeを破壊する

上記対策を96000Hzで実機検証したところ、mux時のA/V同期補正が`audio_start=0.000`という異常値になり、`-itsoffset`が巨大な値(絶対epoch秒そのもの)になって出力ファイルが実質的に壊れる(2MB程度の空ファイル相当)不具合が発生した。

切り分けのため、単体の`ffmpeg -copyts -f pulse -sample_rate <rate> -i <sink>.monitor -c:a aac ...`を様々な条件で実行し比較した:

| サンプルレート | コンテナ | コーデック | start_time |
|---|---|---|---|
| 48000/64000Hz | m4a/mp4/mkv | aac | 正常(絶対epoch秒) |
| 88200/96000Hz | m4a(ipod)/mp4 | aac | **0.000(破壊)** |
| 88200/96000Hz | mkv | aac | ほぼ0(相対値に正規化、絶対epoch秒を保持しない=用途に合わない) |
| 88200/96000Hz | mov/wav | **pcm_s16le** | wavはN/A(コンテナがstart_time非対応)、**movは正常(絶対epoch秒を保持)** |

以上から、**問題はコンテナではなくAACエンコーダ自体が88200/96000Hzのときに`-copyts`のタイムスタンプ処理を壊す**libavcodecの不具合(または未知の制限)であり、48000/64000Hzでは発生しないことを特定した。原因の完全な特定(AACのエンコーダディレイ計算にサンプルレート依存のオーバーフロー等があるか)には至っていない。

### 11.5 対策2: 録音はPCM(mov)で行い、mux時にAAC変換する

`recorder/options.py`の`audio_target`を倍速録画時のみ`.audio.mov`(pcm_s16le)に変更し、`recorder/ffmpeg.py`の`build_audio_ffmpeg_cmd()`もPCMで録音するよう変更した。`mux_audio_video()`側で、倍速録画時のみ`-c:a aac -b:a 192k`による再エンコードを行うようにした(この段階のAACエンコードは絶対epoch秒を扱わない通常のmux処理のため、§11.4の不具合の影響を受けない)。

実機再検証の結果、`A/V同期補正: video_start=... audio_start=... delta=+0.624s`という正常な値が得られ、重複フレーム率0.0〜0.1%で試行1回目に成功するようになった。

### 11.6 対策3: 録音シンクのレートをゲームの実出力レートに合わせる(44100Hz基準へ訂正)

初期実装では`NATIVE_AUDIO_RATE_HZ = 48000`(PulseAudio `auto_null`の実レートに合わせた値)としていたが、DirectSoundのセカンダリバッファの既定レートは44100Hzであるため、2倍速時のシンクレートが96000Hz(48000×2)になり、ゲームの実際の出力レート(44100×2=88200Hz)と一致していなかった。この不一致により余分なリサンプリングが発生している可能性を考慮し、`NATIVE_AUDIO_RATE_HZ`を44100Hzに修正した(2倍速で88200Hzとなり、ゲームの出力レートと厳密に一致する)。

また、`ensure_audio_sink()`に「既存シンクのレートが期待値と異なる場合は一旦アンロードして作り直す」ロジックを追加する過程で、`pactl list short sinks`の1列目(シンクインデックス)を誤って`pactl unload-module`に渡すバグ(モジュールインデックスとシンクインデックスは別の名前空間)を発見・修正した。正しくは`pactl list sinks`(詳細表示)の`Owner Module:`から対応するモジュールIDを取得する必要がある。

### 11.7 88200Hzへの変更後も音質は大きく改善しなかった

§11.3〜11.6の対策(録音88200Hz化)を適用して再度FFTスペクトルを比較したところ、10-12kHz帯で81.5dB(ネイティブ復元後の目標値は110dB前後)と、依然としてネイティブに遠く及ばない結果になった。96000Hz版(79.3dB)とほぼ同水準であり、**シンクのサンプルレートを上げるだけでは高域はほとんど改善しないことが判明した**。

### 11.8 ユーザー指示によるMOD側追加対策: プライマリバッファのSetFormatフック(効果は限定的、未解決)

ユーザーから「MOD実装を含めた解決を試みてください」との指示を受け、`mods/common/dsound_hook.cpp/h`に以下を追加実装した:

- `IDirectSound8::SetCooperativeLevel`(vtable[6])をフックし、`DSSCL_NORMAL`(1)未満/相当の要求を`DSSCL_PRIORITY`(2)以上に底上げする`MySetCooperativeLevel`。プライマリバッファへの`SetFormat`は協調レベルが`DSSCL_PRIORITY`以上でないと`DSERR_PRIOLEVELNEEDED`で失敗するため。
- `ScalePrimaryBufferFormat()`: プライマリバッファのCreateSoundBuffer成功時に`GetFormat`(vtable[5])で現在のフォーマットを取得し、`nSamplesPerSec`を`g_freqScale`倍(`nAvgBytesPerSec`も再計算)して`SetFormat`(vtable[14])で書き戻す。

**実機検証で得られた重要な事実**: th15のプライマリバッファは事前の想定(44100Hz固定)と異なり、**実際には22050Hzだった**。`ScalePrimaryBufferFormat: 22050 -> 44100 Hz (freqScale=2.0000) setFormat hr=0x00000000`とログに出力され、`SetFormat`呼び出し自体は成功(`S_OK`)した。

しかし、この状態で録音した音声のFFTスペクトルは、対策前(88200Hzシンクのみ)とほぼ同水準(10-12kHz帯で81.5dB)であり、**プライマリバッファのSetFormatが成功しても、実際の録音音質には有意な改善が見られなかった**。

**未解決の仮説**: Wineの`dsound.dll`実装が、プライパリバッファの`SetFormat`呼び出しを論理的に受理(`S_OK`を返す)しても、実際のオーディオデバイス層(`winepulse.drv`経由のPulseAudioストリーム)には反映していない可能性が高い。DirectSoundのソフトウェアミキサーが「プライマリの論理フォーマット」と「実際にPulseAudioへ送出するストリームのネゴシエートレート」を別々に管理しており、後者は最初のストリームオープン時点のレートに固定されたままである、という構造が疑われる。この仮説の検証(Wineソースコードの該当箇所の確認、`WINEDEBUG=+dsound,+winmm,+wave`等での詳細トレース取得)は未実施。

### 11.9 次回セッションへの引き継ぎ事項

- **音声高域欠落問題は未解決のまま**。現状の到達点は「録音シンクを88200Hz化することで、対策前(48000Hz固定)よりは高域の減衰開始点がわずかに改善する」レベルに留まる(定量的な比較は§11.2と§11.7の表を参照)。「プライマリバッファのSetFormat」はMOD側の対策として実装・実機確認まで完了したが、効果は実測されなかった。
- 次回調査で試すべき方向性の候補:
  1. `WINEDEBUG=+dsound,+winmm,+wave`(または関連チャンネル)を有効にして、Wine側のログでプライマリバッファのフォーマット変更がPulseAudioストリームのオープン/リオープンにどう反映される(されない)かを直接観測する。
  2. Wine(`dlls/dsound/`)のソースコードを確認し、`SetFormat`が実際にどこまで下流(`winepulse.drv`)に伝播する設計になっているかを読む。ソースはローカルにcloneが無ければ`apt source wine`または上流リポジトリから取得する必要がある。
  3. `IDirectSoundBuffer::SetFormat`ではなく、`IDirectSound::SetSpeakerConfig`や、より低レベルなwinepulse.drv側のレート決定ロジック(`waveOutOpen`相当)に介入する余地がないか調査する。
  4. 別アプローチとして、DirectSoundを経由せず、Wine起動時の環境変数(`PULSE_LATENCY_MSEC`や、PulseAudioクライアントライブラリのAPIレベルでのサンプルレート強制)でプライマリの実効レートを引き上げられないか検討する。
  5. 「音質は妥協し、速度・同期の正確性のみを担保する」という割り切りも選択肢として残しておく(ユーザーの用途次第では、多少のこもりを許容できる可能性がある)。
- 一方で、**カクつき問題(§11.1)は`poll_side_stream=True`の追加により実質的に解決した**。この修正は`recorder/games.py`にコミット済みで、今後のth15録画(倍速に限らずネイティブ・低速でも)すべてに適用される。
- 本フェーズで音声パイプラインに加えた変更(§11.3〜11.6)は倍速録画時(`MENU_TIME_SCALE<1.0`)のみ分岐するため、ネイティブ/低速録画の既存動作(音声は`auto_null.monitor`から直接AACエンコード)には影響しない。

## 未実施(次フェーズへ)

- 4倍速・5倍速を正しい実装(高フレームレートキャプチャ+vsync 0)で再検証し、CPU/GPU使用率も含めた限界の確定
- 通常ステージ(Hard、th15_07.rpy)での倍速録画検証(Extraより処理落ちが起きにくい可能性)
- フル尺(全ステージ)での倍速録画・理論尺比較・A/V同期確認
- `speed_hack_hook`をth15以外のタイトル(th20等)に展開する場合の互換性確認(QPCベースの実装なので理論上は他タイトルにも適用できるはずだが未検証)
- `FPS_RUNAWAY_HZ_THRESHOLD`のタイトル別既定値をGameConfig側に倍速録画向けとして正式に用意するか検討
- NVENC使用時のレート制御パラメータ(`-cq`/`-b:v`/`-maxrate`)の画質チューニング(reports/84で「今後の課題」とされたまま)
- **【最優先】音声高域欠落問題の根本解決**(§11.9の引き継ぎ事項を参照)。倍速録画を本番投入する場合、現状は「速度・同期は正確だが音質はやや劣化する」状態であることをユーザーに明示する必要がある。

## 変更ファイル

- 新規: `mods/common/speed_hack_hook.h`, `mods/common/speed_hack_hook.cpp`
- 変更: `mods/th15_replay_autoplay/dllmain.cpp`(`InstallSpeedHackHook`・`InstallTimerProbeHook`の組み込み)
- 変更: `mods/common/dsound_hook.h`, `mods/common/dsound_hook.cpp`(プライマリバッファの`SetFormat`・`SetCooperativeLevel`フック追加、§11.8。効果未確認のまま次フェーズへ持ち越し)
- 変更: `recorder/games.py`(th15に`gpu_display=True`・`crtc_mode="1280x960"`・`poll_side_stream=True`を追加、GPU検証結果および終了検知ポーリング対策の反映漏れを修正)
- 変更: `recorder/options.py`, `recorder/cli.py`(`--gpu-encode`フラグ追加、reports/84のNVENC知見をrecorder/へ実装。`audio_target`の倍速時mov切り替えも追加)
- 変更: `recorder/ffmpeg.py`(`CAPTURE_FRAME_RATE_HZ`・`-vsync 0`・NVENCエンコード分岐・倍速時の音声入出力切り替え・mux時のAAC変換分岐を追加)
- 変更: `recorder/pipeline.py`(stutter probeの誤検知対策、`ensure_audio_sink()`の呼び出し追加)
- 変更: `recorder/stutter.py`, `recorder/timing.py`(倍速側での閾値計算バグ修正、`AUDIO_CAPTURE_RATE_HZ`/`NATIVE_AUDIO_RATE_HZ`の追加)
- 変更: `recorder/config.py`(`DOUBLESPEED_SINK_NAME_PREFIX`定数、`build_env()`での`PULSE_SINK`設定)
- 変更: `recorder/instance.py`(`ensure_audio_sink()`新規実装、シンクのOwner Module検索によるレート不一致時の再作成)
- 新規(ローカルのみ、gitignore対象): `/mnt/cache3/sattori-th15-verify/doublespeed_verify/`配下に各種検証動画(最終版: `th15_extra_2x_fixed_v3_primaryfix_restored.mp4`)
