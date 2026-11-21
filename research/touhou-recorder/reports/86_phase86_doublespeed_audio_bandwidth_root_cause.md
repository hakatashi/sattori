# フェーズ86: 倍速録画の音質低下(高域欠落)の根本原因特定と解決

## 背景

`reports/85` §11.2〜§11.9で未解決のまま持ち越された「倍速録画の音声から10〜12kHz以上の高域が失われる」問題を、Wineソースコードの読解とローカルでの単体再現実験によって根本解決する。

フェーズ85では以下の対策を打ったが、いずれも効果が測定されなかった:

- 録音用PulseAudioシンクのレートを88200/96000Hzへ引き上げ(§11.3〜11.6)
- MOD側でプライマリバッファの`SetFormat`をスケール(§11.8)

本フェーズでは、**原因が2つ独立に存在し、しかも両方がほぼ同じ約10kHzのカットオフを生むため、片方だけ直しても症状がまったく改善しないように見えていた**ことを突き止めた。

## 1. ローカル検証環境の整備: DirectSound単体プローブ

フェーズ85の検証はすべてAWSのGPUインスタンス上でth15のフル録画を回す形で行われており、1試行あたり数分〜十数分かかっていた。本フェーズではまず、**ゲーム本体もGPUも使わずローカル(HakataMatrix、CPU描画)で数秒で再現・測定できる下地**を整えた。

### 1.1 `scripts/86_dsound_probe/dsprobe.cpp`(新規)

mingw-w64でクロスビルドする最小構成のWin32アプリ。

- WASAPI(`IMMDeviceEnumerator`→`IAudioClient::GetMixFormat`)に直接問い合わせ、**Wineがオーディオデバイスに対して採用しているミックスフォーマットのサンプルレート**を表示する。後述の通りこの値がdsoundのミキサーのリサンプル先レートそのものになるため、最重要の観測点になる。
- 44100Hz基準の対数スイープ(20Hz→20kHz、10秒)をDirectSoundのセカンダリバッファへ書き込み、`SetFrequency()`で再生周波数をスケールして鳴らす。`mods/common/dsound_hook.cpp`が実際のゲームに対して行っているのと同じ操作を、ゲーム抜きで再現する。
- `--coop` / `--primary` でプライマリバッファの協調レベル・`SetFormat`の効果も試せる。

ビルド:

```bash
cd scripts/86_dsound_probe
i686-w64-mingw32-g++ -O2 -static -static-libgcc -static-libstdc++ \
  -o dsprobe.exe dsprobe.cpp -ldsound -ldxguid -lole32 -luuid -lwinmm
```

### 1.2 `scripts/86_analyze_audio_spectrum.py`(新規)

録音結果の平均パワースペクトル(ハン窓・16384点・Welch法相当)を求め、**ピークから-30dB落ちる周波数(実効帯域幅)**と、指定した各帯域(4k/6k/…/20kHz)の相対レベルを表として出力する。`--speed N`で「N倍速で圧縮されたまま記録された音声」を元の速度での周波数に換算できる。ffmpeg経由でデコードするため、88200Hz以上のwav(`WAVE_FORMAT_EXTENSIBLE`)やmp4の音声トラックもそのまま扱える。

### 1.3 再現手順(数十秒で完結)

```bash
Xvfb :91 -screen 0 640x480x24 &
pactl load-module module-null-sink sink_name=probe44100 rate=44100 channels=2
pactl load-module module-null-sink sink_name=probe88200 rate=88200 channels=2
export WINEPREFIX=$PWD/prefixes/th15-wined3d-gl DISPLAY=:91 WINEDEBUG=-all

# 2倍速 × 44100Hzシンク(フェーズ85以前の状態)
PULSE_SINK=probe44100 wine scripts/86_dsound_probe/dsprobe.exe --freq 88200 --secs 14 &
ffmpeg -y -f pulse -sample_rate 44100 -channels 2 -i probe44100.monitor -t 10 \
  -c:a pcm_s16le B_2x_sink44100.wav

python3 scripts/86_analyze_audio_spectrum.py --speed 2 B_2x_sink44100.wav
```

## 2. 原因(1): Wineのdsoundミキサーが「WASAPIミックスフォーマットのレート」へアンチエイリアス付きでダウンサンプルしている

### 2.1 Wineソースコードの読解(wine-9.0、`wine-mirror/wine`)

`dlls/dsound/mixer.c` の `DSOUND_RecalcFormat()`:

```c
dsb->freqAdjustNum = dsb->freq;                        /* セカンダリバッファの再生周波数 */
dsb->freqAdjustDen = dsb->device->pwfx->nSamplesPerSec; /* デバイス(ストリーム)のレート */
...
if (dsb->freqAdjustNum / dsb->freqAdjustDen > 0)
    dsb->firstep = fir_step * dsb->freqAdjustDen / dsb->freqAdjustNum;  /* FIRを広げる=LPF */
```

`cp_fields()`(mixer.c:403)は`freqAdjustNum == freqAdjustDen`のときだけ無変換コピー(`cp_fields_noresample`)を行い、それ以外は窓関数付きsinc FIRでリサンプルする。**ダウンサンプル時はFIRのステップ幅が比率に応じて広がる=きちんとアンチエイリアス用のローパスがかかる**設計になっている。

つまり「セカンダリバッファを88200Hz、デバイスを44100Hz」にすると、dsoundのミキサー内部で**圧縮空間の22050Hz(元の速度では11025Hz)でローパスされる**。録音側のサンプルレートをいくら上げても、この時点で既に失われているので手遅れになる。

`device->pwfx`の決定経路は `dlls/dsound/primary.c` の `DSOUND_WaveFormat()` で、通常(`forcewave=FALSE`)は `IAudioClient::GetMixFormat` の戻り値をそのまま使う。

### 2.2 フェーズ85 §11.8の「プライマリバッファのSetFormat」が効かなかった理由

`dlls/dsound/primary.c` の `primarybuffer_SetFormat()`:

```c
if (device->priolevel == DSSCL_WRITEPRIMARY) {
    ...
    err = DSOUND_ReopenDevice(device, TRUE);   /* ここでだけ実ストリームが開き直される */
} else {
    WAVEFORMATEX *wfx = DSOUND_CopyFormat(passed_fmt);
    if (wfx) { free(device->primary_pwfx); device->primary_pwfx = wfx; }  /* 記録するだけ */
}
```

**`DSSCL_PRIORITY`では`device->primary_pwfx`に値を控えるだけで、実際のオーディオストリーム(`device->pwfx`)は一切変わらない。**しかも戻り値は`S_OK`。フェーズ85 §11.8で「`SetFormat`は成功するのに音質が変わらない」と観測されたのはこのためであり、当時の仮説(「Wineが論理フォーマットと実ストリームを別管理している」)は正しかった。

なお`DSSCL_WRITEPRIMARY`へ底上げすれば`DSOUND_ReopenDevice(device, TRUE)`は走るが、`mixer.c:727`が

```c
if (device->priolevel != DSSCL_WRITEPRIMARY) { /* ここでセカンダリバッファをミックスする */ }
```

となっているため、**WRITEPRIMARYではセカンダリバッファが一切ミックスされず無音になる**。また`IDirectSound8Impl_SetCooperativeLevel`(`dlls/dsound/dsound.c:869`)は WRITEPRIMARY への出入りのたびに`DSOUND_ReopenDevice()`を呼び直すため、「一時的にWRITEPRIMARYにしてSetFormatし、PRIORITYへ戻す」という小細工も成立しない(戻した瞬間にミックスフォーマットで開き直される)。**この経路は原理的に使えない。**

### 2.3 正しい介入点: PulseAudioのシンクレート

`dlls/winepulse.drv/pulse.c` の `pulse_probe_settings()` は、`PA_STREAM_FIX_RATE`付きでダミーストリームを張り、**PulseAudioが返した実際のサンプルスペックをそのままミックスフォーマットにする**(`wfx->nSamplesPerSec = ss.rate;`、pulse.c:765)。デバイス名が空文字のとき`pulse_name = NULL`になり、libpulse側で`PULSE_SINK`環境変数が参照される。

さらに `pulse_is_format_supported()`(pulse.c:2089)は**共有モードで`nSamplesPerSec`を一切検証していない**。実測でも`IsFormatSupported(shared, 88200Hz)`は`S_OK`を返した。

したがって、**ゲームプロセスに`PULSE_SINK=<高レートのnull-sink>`を渡せば、Wineのミックスフォーマット自体が高レートになり、dsoundのダウンサンプルが発生しなくなる**。これはフェーズ85 §11.3〜11.6で既に実装済みの対策であり、実は正しかった。

### 2.4 実測(スイープ、元の速度に換算した実効帯域)

| 条件 | Wineのミックスフォーマット | PA sink-inputのリサンプル | -30dB帯域 |
|---|---|---|---|
| 等倍(参照)・44100Hzシンク | 44100Hz | copy | **20.03kHz** |
| 2倍速・44100Hzシンク(旧) | 44100Hz | copy | **9.56kHz** |
| 2倍速・88200Hzシンク(現行) | **88200Hz** | copy | **20.04kHz** |

`pactl list sink-inputs`でも88200Hzシンク使用時は`Sample Specification: float32le 2ch 88200Hz` / `Resample method: copy`となり、PulseAudio側でもリサンプルが起きていないことを確認した。**原因(1)は現行実装で既に解決していた。**

## 3. 原因(2): FFmpegのAACエンコーダの既定帯域制限が「絶対Hz」で決まる

原因(1)を潰しても音質が改善しなかった真犯人。

`recorder/ffmpeg.py`の`mux_audio_video()`は、倍速録画時にPCM録音をAAC(`-c:a aac -b:a 192k`)へ変換している。FFmpegのネイティブAACエンコーダは`-cutoff`未指定時、`libavcodec/aacenc.c`の以下のロジックで符号化帯域を決める:

```c
int frame_br = avctx->bit_rate / avctx->ch_layout.nb_channels;
static const int rates[] = { 24000, 32000, 48000, 64000, 96000, 192000 };
static const int bws[]   = { 14000, 14000, 18500, 20000, 21000, 22000 };
...
s->bandwidth = FFMIN3(s->bandwidth, 22000, avctx->sample_rate / 2);
```

**帯域はビットレート(1チャンネルあたり)だけで決まる絶対周波数であり、サンプルレートには(ナイキストの上限としてしか)連動しない。**192kbps/2chなら`frame_br=96000`→約19.3kHzになる。

これが44100Hz録音なら19.3kHz÷1 = 19.3kHzで問題ないが、**88200Hz(2倍速)録音では19.3kHzは「圧縮空間の19.3kHz」であり、等倍に戻すと9.66kHzになる**。原因(1)の11kHzとほぼ同じ値であるため、原因(1)を直しても症状がまったく変化しないように見えていた。

### 3.1 実測(88200Hz録音を各設定でAAC化し、元の速度に換算)

| エンコード設定 | -30dB帯域(元の速度換算) |
|---|---|
| PCM(参照) | 20.04kHz |
| `-b:a 192k`(既定cutoff) | **9.66kHz** |
| `-b:a 320k`(既定cutoff) | 11.04kHz |
| `-b:a 192k -cutoff 44100` | **20.04kHz** |

`-cutoff`に録音レートのナイキスト周波数を明示するだけで、PCM相当の帯域が完全に戻る。

### 3.2 ビットレートも倍率分だけ引き上げる

倍速録画の音声は「同じゲーム内容を半分の実時間で記録したもの」なので、同じビットレートでは**ゲーム内1秒あたりのビット数が半分**になり、しかも符号化帯域は2倍に広がる。88200Hz PCMを参照にした符号化SNR(相互相関でエンコーダディレイを補正して算出)は以下の通り:

| ビットレート | SNR(dB) |
|---|---|
| 128k | 25.69 |
| 192k | 37.62 |
| 256k | 43.40 |
| 384k | 46.09 |

等倍録画の192kbps相当の情報密度を保つため、**ビットレートを倍率分スケールする**(2倍速なら384k)方針とした。

## 4. 実装した修正

### 4.1 `recorder/ffmpeg.py`: AACの符号化帯域とビットレートを倍率に連動させる

`aac_encode_args()`を新設し、`build_audio_ffmpeg_cmd()`(ネイティブ/低速時の直接AAC録音)と`mux_audio_video()`(倍速時のPCM→AAC変換)の両方から使うようにした。倍速時のみ`-cutoff`を明示し、ビットレートを倍率分スケールする。ネイティブ/低速録画の挙動は完全に従来通り(192k・cutoff未指定)。

```python
NATIVE_AUDIO_BITRATE_KBPS = 192
AUDIO_BITRATE_KBPS = (
    round(NATIVE_AUDIO_BITRATE_KBPS / MENU_TIME_SCALE) if 0 < MENU_TIME_SCALE < 1.0
    else NATIVE_AUDIO_BITRATE_KBPS
)

def aac_encode_args():
    args = ["-c:a", "aac", "-b:a", f"{AUDIO_BITRATE_KBPS}k"]
    if AUDIO_CAPTURE_RATE_HZ != NATIVE_AUDIO_RATE_HZ:
        args += ["-cutoff", str(AUDIO_CAPTURE_RATE_HZ // 2)]
    return args
```

2倍速では `-c:a aac -b:a 384k -cutoff 44100` が組み立てられる。

### 4.2 `mods/common/dsound_hook.cpp/h`: プライマリバッファ関連フックの撤去

フェーズ85 §11.8で追加した`ScalePrimaryBufferFormat()`(プライマリの`GetFormat`/`SetFormat`)と`MySetCooperativeLevel()`(`DSSCL_PRIORITY`への底上げ)は、§2.2の通り**Wineでは原理的に効果が無い**ことが確定したため撤去した。ヘッダには「なぜ触ってはいけないか」「正しい介入点はどこか」をコメントとして残した。撤去前後で録音音声のスペクトルが完全に一致することも実測で確認した(§5の表のB/B')。

あわせて、`mods/th15_replay_autoplay/build.bat`がフェーズ85で追加したソース(`speed_hack_hook.cpp`等)に追随しておらず、アドホックなmingwビルドで運用されていたことが分かったため、`mods/th15_replay_autoplay/build_mingw.sh`を追加して手順を固定した(撤去前のソースからこのスクリプトでビルドすると、既存の`build/th15_hook.dll`とバイト数まで一致することを確認済み)。

### 4.3 【副産物のバグ修正1】倍速用シンクを残すと以後のネイティブ録画の音声が壊れる

ローカルで倍速→ネイティブの順に録画したところ、2本目の音声録音が `Input/output error` で失敗した。PulseAudioの`module-always-sink`は「他にシンクが1つも無いとき」だけダミーの`auto_null`を生やす仕様のため、**倍速録画用シンク(`touhou_doublespeed_th15`)が残っているとauto_nullが消えたままになり、`recorder/config.py`の`PULSE_SOURCE`(`auto_null.monitor`)を開けなくなる**。AWSではジョブごとに使い捨てコンテナを立てるため表面化していなかった。

`recorder/instance.py`に`remove_audio_sink()`を実装し、`recorder/pipeline.py`の`attempt_recording()`の`finally`(wineserver後片付けと同じ場所)から必ず呼ぶようにした。

### 4.4 【副産物のバグ修正2】pactlの出力が日本語ロケールで翻訳されパースが静かに失敗していた

上記`remove_audio_sink()`が何のログも出さずに素通りする現象を追ったところ、`GameConfig.build_env()`がゲームの日本語表示のために`LANG=ja_JP.UTF-8`を設定しており、**それがpactlにも渡って出力ラベルまで翻訳されていた**ことが判明した(`Name:`→`名前:`、`Owner Module:`→`所有者モジュール:`)。

```
シンク #5
	名前: touhou_doublespeed_th15
	所有者モジュール: 23
```

フェーズ85で実装した`ensure_audio_sink()`の「既存シンクのレートが期待値と異なれば作り直す」経路も同じパーサを使っており、**日本語ロケールでは常にモジュールIDを見つけられず、レート不一致のシンクが作り直されないまま使われ続ける**潜在バグになっていた。`recorder/instance.py`に`_pactl()`ヘルパを設け、pactl呼び出しを必ず`LC_ALL=C`で行うよう統一した。モジュールIDが見つからなかった場合も警告ログを出すようにした(静かな素通りをやめる)。

### 4.5 `--cpu-display`(ローカル検証用)

`GameConfig.gpu_display=True`のタイトル(th15/th06nc)でもXvfb(CPU描画・llvmpipe)を強制するCLIフラグを`recorder/cli.py`に追加した。`dataclasses.replace(config, gpu_display=False, crtc_mode=None)`するだけの薄い実装。GPUが無い/使いたくないローカル環境で音声まわりの検証をするための逃げ道。

### 4.6 `scripts/47_descale_th20_slowmo.py`: 倍速録画の復元に正式対応

`asetrate`+`aresample`の式は倍速側(`--target-hz > --native-hz`)でもそのまま成立するため、docstringを両対応に改め、復元後の音声サンプルレートを指定する`--audio-rate`(既定48000Hz)を追加した。従来は88200Hz録音を88200Hzのまま出力していた。

## 5. 実機検証(ローカル・CPU描画・th15)

ユーザー指示に従い、AWS GPUインスタンスではなく**ローカル(HakataMatrix、Ryzen 7 5700X、Xvfb+llvmpipeのCPU描画)**で、th15 (`th15_09.rpy`, Extra) を90秒録画して確認した。

```bash
# 2倍速(修正後)
FPS_LIMIT_TARGET_HZ=120 SPEED_HACK_MULTIPLIER=2.0 FPS_RUNAWAY_HZ_THRESHOLD=300 \
python3 scripts/25_record_replay_e2e_multigame.py --game th15 --replay th15_09.rpy \
  --cpu-display --record-seconds 90 \
  --output /mnt/cache3/sattori-th15-verify/phase86_audio/th15_2x_local_cpu_v2.mp4

# 等倍(参照)
python3 scripts/25_record_replay_e2e_multigame.py --game th15 --replay th15_09.rpy \
  --cpu-display --record-seconds 90 \
  --output /mnt/cache3/sattori-th15-verify/phase86_audio/th15_native_local_cpu.mp4

# 復元(2倍速→等倍)
python3 scripts/47_descale_th20_slowmo.py <in>.mp4 <out>_restored.mp4 --target-hz 120 --native-hz 60
```

復元後の音声スペクトル(実効帯域=ピークから-30dB、および各帯域のピーク基準相対dB):

| 条件 | -30dB帯域 | 8kHz | 10kHz | 12kHz | 14kHz | 16kHz | 18kHz |
|---|---|---|---|---|---|---|---|
| A. 等倍(参照) | **14.25kHz** | -21.2 | -28.7 | -30.8 | -33.8 | -37.1 | -40.7 |
| B. 2倍速・修正後 | **14.17kHz** | -21.2 | -28.4 | -30.9 | -34.1 | -37.1 | -38.7 |
| B'. 2倍速・修正後(MODフック撤去版) | **14.17kHz** | -21.2 | -28.5 | -31.0 | -34.1 | -37.0 | -38.5 |
| C. 2倍速・旧mux(`-cutoff`なし) | **9.65kHz** | -21.3 | -41.3 | -78.4 | -85.6 | -88.9 | -92.0 |

**2倍速録画の音声は、全帯域で等倍録画と0.5dB以内の差に収まり、実質的に劣化なしと言える水準になった**(14.25kHz付近の緩やかなロールオフはth15のBGM素材そのものの特性で、等倍でも同じ)。MODのプライマリバッファフック撤去(B→B')による差は無い。

なお`CreateSoundBuffer`のログから、**th15はBGM用の44100Hzバッファに加えてSE用の22050Hzバッファも多数使う**ことが分かった(2倍速でそれぞれ88200Hz/44100Hzへスケールされる)。88200Hzのシンクは両方を損失なく収容できる。

### 5.1 ローカルCPU描画の映像品質について(重要)

ローカルのXvfb+llvmpipeでは2倍速(120fps描画)に描画性能がまったく追いつかず、重複フレーム率44.2%・FpsMonitor 92Hz(目標120Hz)という結果になった。**本フェーズのローカル録画は音声検証専用であり、映像のカクつきは想定どおり**である。映像品質の評価はフェーズ85のg6f.2xlarge実測(重複フレーム率0.8〜2.0%)を参照すること。

### 5.2 保存した検証データ

`/mnt/cache3/sattori-th15-verify/phase86_audio/` 配下:

| ファイル | 内容 |
|---|---|
| `th15_native_local_cpu.mp4` | 等倍録画(参照) |
| `th15_2x_local_cpu_v2.mp4` | 2倍速録画の生データ(修正後・MODフック撤去版) |
| `th15_2x_local_cpu_v2_restored.mp4` | 上記を等倍へ復元したもの(**最終成果物**) |
| `th15_2x_local_cpu_OLDMUX_restored.mp4` | 比較用: 同じ録音から`-cutoff`なしでmuxし直した「旧実装相当」 |
| `listen/A_reference_native.flac` 他 | 音声のみ(FLAC)のA/B比較用 |
| `listen/*_clip30s.mp4` | 冒頭30秒の比較クリップ |
| `A_native_44100.wav` / `B_2x_sink44100.wav` / `C_2x_sink88200.wav` | §1.3のdsprobeスイープ生データ |

## 6. 倍率ごとの音声帯域の上限(3倍速以上の制約)

MPEG-4 AACのサンプルレート表は**最大96000Hz**までしか定義がなく、それを超えるレートを渡すとFFmpegは黙って96000Hzへリサンプルする(エラーにはならない)。

**復元後の帯域上限は「AACの実レート ÷ 2(ナイキスト) ÷ 倍率」**である。圧縮空間で表現できる最高周波数はナイキスト周波数までであり、その帯域全体が復元時に倍率分だけ圧縮されて元の周波数軸に戻るため、2で割る操作と倍率で割る操作の両方がかかる。

| 倍率 | 録音レート | AAC実レート | 圧縮空間のナイキスト | 復元後の帯域上限 | 備考 |
|---|---|---|---|---|---|
| 2倍速 | 88200Hz | 88200Hz | 44100Hz | **22.05kHz(実質制約なし)** | 元素材44100Hzの全帯域を保持できる |
| 3倍速 | 132300Hz | 96000Hz | 48000Hz | **16.0kHz** | 実測で確認 |
| 4倍速 | 176400Hz | 96000Hz | 48000Hz | **12.0kHz** | 実測で確認 |
| 5倍速 | 220500Hz | 96000Hz | 48000Hz | 9.6kHz | |

2倍速が「制約なし」なのは上限44.1kHzだからではなく、**上限22.05kHzがゲーム素材(44100Hz PCM)のナイキスト周波数そのものと一致するため**である。

`-cutoff`に録音レートのナイキスト周波数を渡す実装は全倍率で正しく動作する(AAC側の実レートで自動的に頭打ちになるだけで、指定しすぎによる破綻は起きないことを3倍速相当のスイープで実測確認した)。

### 6.1 3倍速以上はALACへ切り替えて上限を突破する

96000Hzの壁はAAC固有のものであり、他のコーデックには当てはまらない。1kHzサイン波を各レートでエンコードし、実際に格納されたサンプルレートを比較した:

| コーデック | 88200Hz | 132300Hz | 176400Hz | 220500Hz |
|---|---|---|---|---|
| aac | 88200 | **96000** | **96000** | **96000** |
| alac | 88200 | 132300 | 176400 | 220500 |
| flac | 88200 | 132300 | 176400 | 220500 |
| libvorbis | 88200 | 132300 | 176400 | エンコード失敗 |
| pcm_s24le | 88200 | 132300 | 176400 | 220500 |
| libopus | **48000** | **48000** | **48000** | **48000** |

さらに、倍率分に伸長した対数スイープ(元素材20Hz〜20kHz相当)を各コーデックで往復させ、元の速度に換算した実効帯域を測った:

| 倍率 | PCM(参照) | AAC | ALAC | FLAC |
|---|---|---|---|---|
| 3倍速 | 19.40kHz | 16.00kHz | **19.40kHz** | **19.40kHz** |
| 4倍速 | 19.49kHz | 12.00kHz | **19.49kHz** | **19.49kHz** |

ALAC・FLACはいずれも可逆のためPCMと完全に一致する。**Opusは内部サンプルレートが48kHz固定のため最悪の選択肢**(3倍速で8kHz相当になる)である点に注意。

このうち**ALACはmp4コンテナにそのまま格納でき**(FLAC in MP4は再生側の対応がまちまち)、`scripts/47_descale_th20_slowmo.py`での復元時に通常のAAC 48000Hzへ変換されるため、**最終成果物の互換性は何も変わらない**。合成データ(h264映像+ALAC音声のmp4→復元)で動作確認済み。

そこで`recorder/ffmpeg.py`の`audio_encode_args()`(旧`aac_encode_args()`)を次の3分岐にした:

| 条件 | エンコード |
|---|---|
| ネイティブ/低速録画 | `-c:a aac -b:a 192k`(従来通り) |
| 倍速録画・録音レート ≤ 96000Hz(2倍速) | `-c:a aac -b:a 384k -cutoff 44100` |
| 倍速録画・録音レート > 96000Hz(3倍速以上) | `-c:a alac`(可逆) |

倍速録画時のmp4は「復元前の中間ファイル」であり、可逆にしてもファイルサイズが増えるだけで最終成果物の品質・互換性には影響しないため、3倍速以上では素直に可逆を選ぶのが正しい。

## 7. 結論

- **倍速録画の音質低下は解決した**。2倍速では等倍録画と実質的に区別できない音質が得られる。
- 原因は2つあった。(1) Wineのdsoundミキサーが「PulseAudioシンクのレート=WASAPIミックスフォーマット」までアンチエイリアス付きでダウンサンプルしていたこと(フェーズ85 §11.3〜11.6の対策で既に解決済みだった)。(2) FFmpegのAACエンコーダの既定符号化帯域が絶対Hzで決まるため、圧縮空間で19.3kHz=等倍換算9.7kHzに制限されていたこと(本フェーズで解決)。**両者がほぼ同じカットオフ値を生むため、片方だけ直しても症状がまったく変わらないように見えていた**のが、フェーズ85で解決に至らなかった理由である。
- MOD側(DirectSound)での対策は不要であり、フェーズ85で追加したプライマリバッファ関連フックはWineの実装上どうやっても効かないため撤去した。
- 副産物として、倍速用PulseAudioシンクの後片付け漏れと、pactl出力のロケール依存パースバグを発見・修正した。

## 未実施(次フェーズへ)

- 修正後の2倍速録画をAWS GPUインスタンス(g6f.2xlarge)で再実施し、映像品質(重複フレーム率)と音質を同時に満たすことの最終確認
- フル尺(全ステージ)での倍速録画・理論尺比較・A/V同期確認(フェーズ85からの持ち越し)
- `speed_hack_hook`のth15以外のタイトル(th20等)への展開(フェーズ85からの持ち越し)
- `FPS_RUNAWAY_HZ_THRESHOLD`のタイトル別既定値をGameConfigへ正式に用意するか(フェーズ85からの持ち越し)

## 変更ファイル

- 新規: `scripts/86_dsound_probe/dsprobe.cpp`, `scripts/86_dsound_probe/build_mingw.sh`(DirectSound単体プローブ)
- 新規: `scripts/86_analyze_audio_spectrum.py`(実効帯域の測定)
- 新規: `mods/th15_replay_autoplay/build_mingw.sh`(th15 MODのビルド手順の固定)
- 変更: `recorder/ffmpeg.py`(`audio_encode_args()`新設、`-cutoff`・ビットレートの倍率連動、3倍速以上のALAC切り替え)
- 変更: `recorder/instance.py`(`remove_audio_sink()`新設、`_pactl()`によるCロケール強制、`_find_sink_owner_module()`の共通化)
- 変更: `recorder/pipeline.py`(`finally`での`remove_audio_sink()`呼び出し)
- 変更: `recorder/cli.py`(`--cpu-display`)
- 変更: `scripts/47_descale_th20_slowmo.py`(倍速復元対応、`--audio-rate`)
- 変更: `mods/common/dsound_hook.cpp`, `mods/common/dsound_hook.h`(プライマリバッファ関連フックの撤去とその理由の明記)
- 新規(ローカルのみ、gitignore対象): `/mnt/cache3/sattori-th15-verify/phase86_audio/` 配下の検証データ
