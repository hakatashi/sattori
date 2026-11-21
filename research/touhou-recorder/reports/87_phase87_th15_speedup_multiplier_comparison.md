# フェーズ87: th15倍速録画の倍率別比較(1.5/2/3/4倍速)と通常ステージ全面の2倍速録画検証

## 背景と目的

フェーズ85(映像: NVENC・`poll_side_stream`・120fpsキャプチャ等)とフェーズ86(音声: `-cutoff`・ビットレート倍率連動・3倍速以上のALAC)の改善を**すべて適用した状態**で、g6f.2xlarge上で以下を検証した。

1. th15 Extra(`th15_09.rpy`)のフル尺2倍速録画の再実施
2. 1.5倍/3倍/4倍速の録画と等倍への復元、倍率間の品質比較(3倍速以上はALAC)
3. 通常ステージ(`th15_07.rpy`、Hard・全6面クリア)のフル尺2倍速録画で、Extra以外でも破綻が無いかの確認

本番に干渉しないよう、us-west-2のスポットインスタンスを使用し、検証後に削除した。

## 1. 環境

| 項目 | 値 |
|---|---|
| インスタンス | `<INSTANCE_ID>`(g6f.2xlarge、スポット、us-west-2a。検証後terminate・スポットリクエスト`<SPOT_REQUEST_ID>`もcancel済み) |
| AZ | us-west-2d/c/bは`InsufficientInstanceCapacity`、aで確保 |
| AMI | `<AMI_ID>`(Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04) 20260922)、gp3 100GiB |
| GPU | GRIDドライバ `latest/`(595.91.07)がそのまま動作(`NVIDIA L4-6Q`)。reports/82で起きたホスト不整合は今回は発生せず |
| キーペア/SG | 既存の`touhou-recorder-nvenc-key`(秘密鍵`/tmp/aws-gpu-nvenc/nvenc-key.pem`)・`<SECURITY_GROUP_ID>` |
| 実行方式 | Dockerを使わずホストへ直接導入(WINEPREFIXのユーザー名に合わせて`hakatashi`ユーザーを作成し、その権限で実行) |

### 1.1 構築手順(次回そのまま使える形)

```bash
# 付属ドライバ撤去 → GRIDドライバ(docs/gpu-recording.md の手順どおり)
sudo apt-get remove --allow-change-held-packages -y 'nvidia-*' 'libnvidia-*'
sudo dpkg --add-architecture i386 && sudo apt-get update
sudo apt-get install -y --no-install-recommends wine wine32 wine64 xdotool openbox x11-utils \
  x11-xserver-utils mesa-utils xserver-xorg-core xserver-xorg-input-libinput ffmpeg \
  pulseaudio pulseaudio-utils language-pack-ja python3-numpy python3-pil rsync sysstat \
  dkms build-essential libgl1:i386 libglx0:i386 libglvnd0:i386 libegl1:i386 libvulkan1:i386
aws s3 cp --no-sign-request --recursive s3://ec2-linux-nvidia-drivers/latest/ grid/ --exclude '*' --include '*grid-aws.run'
sudo sh grid/NVIDIA-Linux-x86_64-*-grid-aws.run --silent --dkms --compat32-libdir=/usr/lib/i386-linux-gnu
sudo cp -a /usr/usr/lib/i386-linux-gnu/* /usr/lib/i386-linux-gnu/ && sudo ldconfig   # 既知の誤配置の修正

sudo useradd -m -s /bin/bash -G sudo hakatashi
sudo loginctl enable-linger hakatashi     # 後述1.2の(4)
# リポジトリ一式(recorder/ scripts/ games/th15 prefixes/th15-wined3d-gl mods/*/build assets)を
# tar+sshで ~hakatashi/touhou-recorder へ転送し、instances/ と runs/ を作成しておく
```

録画は`scripts/87_run_speedup_batch.sh`(新規)で、ラベル・リプレイ・倍率の組を順に`scripts/25`へ流した。倍率Nに対して`FPS_LIMIT_TARGET_HZ=60N`・`SPEED_HACK_MULTIPLIER=N`・`FPS_RUNAWAY_HZ_THRESHOLD=max(300, 1.3×60N)`を設定し、全条件`--gpu-encode`(NVENC)。録画中は`mpstat 1`と`nvidia-smi dmon -s u -d 1`を並走させた。

```bash
FPS_LIMIT_TARGET_HZ=120 SPEED_HACK_MULTIPLIER=2 FPS_RUNAWAY_HZ_THRESHOLD=300 \
python3 scripts/25_record_replay_e2e_multigame.py --game th15 --replay th15_09.rpy --gpu-encode \
  --output ~/out/extra_2x.mp4
# 復元(ローカルで実施)
python3 scripts/47_descale_th20_slowmo.py extra_2x.mp4 extra_2x_restored.mp4 --target-hz 120
```

**注意**: 録画時の`recorder/ffmpeg.py`には、NVENCの`-b:v`/`-maxrate`を倍率分スケールする試験的変更(2倍速で`10000k`/`12000k`)が入っていた。§5.1のとおり`-vsync 0`時はそもそもレート上限が効いておらず効果が検証できなかったため、コミットせずに取り消した。

### 1.2 構築時に踏んだ落とし穴(いずれも環境構築手順側の問題)

1. **32bitの`libGL.so.1`が無いとth15が「Direct3D オブジェクトは何故か作成出来なかった」ダイアログで止まる**。`--no-install-recommends`でwineを入れるとlibglvndのi386版が入らない。GRIDドライバの32bitライブラリ(`libGLX_nvidia.so.0`)だけあっても、ディスパッチャの`libGL.so.1`(i386)が必要。録画パイプラインはこのダイアログ(416x123)をゲームウィンドウとして検出し、stutter probeの重複率100%で3回失敗する形で表面化した。
2. **`xrandr`(x11-xserver-utils)が無いとCRTCモード設定が警告のみでスキップされる**(`WARNING: xrandrの出力名を取得できませんでした`)。1024x768のまま録画されるのを防ぐため必須。
3. **`instances/`ディレクトリが無いと`prepare_instance()`のrsyncが失敗する**。
4. **SSH切断で`/run/user/<uid>`が消えてPulseAudioに繋がらなくなる**。`loginctl enable-linger`で解消。
5. `pkill -f <パターン>`をSSHのコマンド文字列内で使うと、そのSSHシェル自体のコマンドラインにもパターンが含まれるため自分自身を殺す(AGENTS.mdの「pkillではなくPIDでkill」と同根)。

## 2. 結果サマリ(Extra、`th15_09.rpy`、ゲーム内153.6秒)

全条件とも**試行1回目で成功し、ScoreMonitorの最終スコアがリプレイ記録(1710121)と完全一致**した。

| 倍率 | キャプチャ | 音声(mux後) | FpsMonitor 中央値/下位5% | CPU平均(8vCPU) | GPU sm/enc | パイプライン判定の重複率 | 復元後の落ちフレーム(15〜165秒) | カクつきバースト | 音声-30dB帯域 |
|---|---|---|---|---|---|---|---|---|---|
| 等倍(基準) | 60fps | AAC 44.1kHz | 59.9 / 59.7Hz | 11.8% | 9.4% / 4.1% | 0.0% | 0 (0.0%) | 0回 | 14.17kHz |
| 1.5倍 | 90fps | AAC (66150→**64000Hz**) | 89.9 / 89.7Hz | 17.6% | 9.1% / 5.8% | 6.0% | 339 (**3.8%**) | 57回(最大10F) | 14.17kHz |
| **2倍** | 120fps | AAC 88.2kHz 384k | 119〜120Hz ※ | 23.7% | 9.2% / 7.4% | 0.0% | **4 (0.0%)** | **2回** | 14.17kHz |
| 3倍 | 180fps | ALAC 132.3kHz | 178.5 / **146.0Hz** | 34.2% | 16.4% / 9.7% | 8.6% | 1264 (**14.0%**) | 236回 | 14.17kHz |
| 4倍 | 240fps | ALAC 176.4kHz | 238.3 / **193.6Hz** | 40.7% | 18.6% / 9.5% | 3.8% | 1789 (**19.9%**) | 267回 | 14.53kHz |

※2倍速1本目はMODログ退避前に上書きされたためFpsMonitor・スコアは2本目(§2.3)で確認。

- 落ちフレーム・バーストは`scripts/81_analyze_stutter_periodicity.py <restored> --start 15 --duration 150`(mpdecimateベース)。
- 帯域は`scripts/86_analyze_audio_spectrum.py`。全倍率とも8〜18kHzの各帯域で等倍と0.5dB以内(20kHzはむしろ倍速側が高い: 等倍-62.0dB、2倍-56.5dB、4倍-53.9dB。等倍録画のAAC 192kの既定帯域19.3kHzのため)。**フェーズ86の音質改善は1.5〜4倍速すべてで機能しており、3倍速以上のALACも期待どおり**。
- CPU使用率は録画開始+20秒〜停止-15秒の区間の`mpstat`平均。4倍速でも8vCPU中41%で、全体としては余裕がある。

### 2.1 2倍速: 実用品質(推奨)

復元後の落ちフレームは150秒中4枚(バースト2回)で、等倍録画と実質同等。映像のタイムライン(§4)も等倍と完全に一定のオフセットで一致し、尺のずれ(ドリフト)は無い。

### 2.2 3倍・4倍速: ゲーム本体が目標fpsを維持できず処理落ち

FpsMonitorの下位5%が3倍速で146Hz(目標180)、4倍速で194Hz(目標240)まで落ち、復元後は14〜20%のフレームが重複(=画面が止まって見える)した。CPU全体には余裕がある(34〜41%)ので、**th15本体(ゲームスレッド、単一スレッド)の処理速度が律速**と考えられる(reports/82の「処理落ちの原因は単一スレッド性能」と整合)。§4のとおり、これは映像タイムラインの伸び(120秒で+0.7〜0.8秒)としても観測され、BGMとゲーム画面が徐々にずれていく(実機の処理落ちと同じ挙動)。

### 2.3 2倍速の再現性(2本目)と処理落ちへの感度

インスタンス削除前にスコア照合のため2倍速Extraをもう1本録った(`extra_2x_run2`)。スコアは一致(1710121)したが、**FpsMonitorが115〜117Hzで、1本目(119〜120Hz)より約3%遅かった**。直前に同じWINEPREFIXでDirectSound遅延プローブ(§6)を繰り返し起動していたため、その残留プロセス(Xvfb :91等)の影響が疑われる(未確定)。このため代表値からは外したが、**2倍速でも約3%の処理落ちがあると、復元後にBGMとゲーム画面が2分あたり約3.6秒ずれる**(`87_compare_timeline.py`でvideo_offsetが+0.53→+4.22秒)ことを示す実例になった。本番の録画ワーカーでは同居プロセスを置かないことが重要。

## 3. 1.5倍速は2倍速より悪い(2つの独立した問題)

### 3.1 周期的なカクつき

復元後に「0.5秒ごとに約10フレーム(167ms)の停止」が数秒続く区間が繰り返し現れた(15〜165秒で57回)。生録画(90fps)を見ると、該当区間では**3フレームに1枚が完全な重複**(`.##.##.##`)になっており、1秒あたりのユニークフレームが約60枚に落ちている。FpsMonitor(GetDeviceState頻度)は89.9Hzで安定しているため、ゲームのロジック更新は90Hzで回っているが**画面に出るフレーム(Present)だけが間引かれている**可能性が高い。2倍速(120/60=整数比)では同種の重複は一切出ないので、QPC偽装(`speed_hack_hook`)とPresent間引き(`fps_limiter_hook`)の周期が非整数比でうなりを起こしている仮説が有力だが、未検証。

### 3.2 音声が0.0756%速く進むドリフト

1.5倍速の音声は66150Hzで録音され、`87_compare_timeline.py`で等倍と照合すると**120秒あたり約-92msずつ前にずれていく**(2/3/4倍速はずれ0.0ms)。mux前のPCM(`intermediate/extra_1.5x.audio.mov`)でも同じずれが出るので、エンコードではなく録音時点で発生している。ずれ率(約-0.075%)は「66150Hz×10ms=661.5フレーム」の端数切り捨て比(661/661.5=**-0.0756%**)と一致し、2/3/4倍速のレート(88200/132300/176400Hz)は10msあたり整数フレームになる。**Wine(winepulse/dsound)内部の10ms周期のフレーム数計算の整数丸め**が原因と推定する(ソース未確認)。音切れ(ゼロ区間)は無い。

### 3.3 AACが66150Hzを黙って64000Hzへリサンプルする

mux後のmp4の音声は`sample_rate=64000`になっていた(AACのサンプルレート表に66150Hzが無いため。reports/86 §6の96000Hz頭打ちと同じ挙動)。`47_descale`は実際のレートを`ffprobe`で読んで`asetrate`を計算するので復元結果は正しいが、倍率によっては録音レートがAACの表外になることは覚えておく必要がある。

**結論: 倍率は「44100×N が100の倍数(10msあたり整数フレーム)」かつ「60N がディスプレイ・キャプチャと整数関係」になる整数倍率(2倍)を使うべき。**

## 4. 等倍録画とのタイムライン照合(`scripts/87_compare_timeline.py`、新規)

リプレイ再生は決定的なので、等倍録画(参照)と倍速の復元動画は「開始位置のずれ」以外は同じ内容になる。参照の各アンカー時刻について、候補動画のどこに同じ映像(32x24グレースケールのMAD最小)・同じ音声(16kHzモノラルの正規化相互相関最大)があるかを独立に探し、`video_offset`・`audio_offset`・その差`av_delta`を出す。**mux時の`-itsoffset`によるストリームのstart_timeを考慮して先頭に無音/黒を足す**(当初これを忘れて等倍側の音声が0.592秒ずれて見え、誤った結論を出しかけた)。

### 4.1 Extra

| 倍率 | video_offset(20秒→140秒) | audio_offset | av_delta(冒頭) | av_delta ÷ 倍率 |
|---|---|---|---|---|
| 1.5倍 | +0.183 → +0.217s | +0.547 → +0.454s(ドリフト、§3.2) | +363ms | 242ms |
| 2倍 | +0.433 → +0.467s(一定) | +0.879s(一定) | **+446ms** | 223ms |
| 3倍 | +0.883 → +1.600s(処理落ち) | +1.453s(一定) | +570ms | 190ms |
| 4倍 | +2.150 → +2.950s(処理落ち) | +2.939s(一定) | 約+700ms(40秒時点) | 約175ms |

- 2倍速は映像・音声とも尺のずれが無い(オフセットが時間によらず一定)。
- **倍速録画の音声は、等倍録画と比べて一定量遅れている**。遅れを倍率で割ると実時間で約0.18〜0.24秒でほぼ一定=**録画時点(実時間)で音声が約0.2秒遅れ、復元でN倍に引き伸ばされている**。

### 4.2 Hard(通常ステージ全6面)

| t_ref | video_off | audio_off | av_delta |
|---|---|---|---|
| 204s | +0.183 | +0.490 | +307ms |
| 612s | +0.367 | +0.570 | +204ms |
| 1020s | +0.733 | +0.860 | +127ms |
| 1225s | +0.933 | +0.930 | -3ms |
| 1633s | +1.300 | +1.300 | 0ms |
| 1837s | +1.333 | +1.300 | -33ms |

映像・音声とも、ステージ間のロード等(実時間で進む区間が復元で2倍に伸びる)のたびに少しずつ一緒に後ろへずれていく(全体で+1.15秒、復元後の総尺も等倍2041.3秒に対し2059.2秒)。**ゲームプレイ中の尺の伸び縮み・ドリフトは無い**。av_deltaは冒頭+0.31秒から中盤以降ほぼ0に収束しており、上記の開始時の遅れがロード区間で吸収されていく形になっている。

## 5. 通常ステージ(Hard、`th15_07.rpy`、ゲーム内2013.6秒)の2倍速録画

| 項目 | 等倍(基準) | 2倍速(復元後) |
|---|---|---|
| 試行 / スコア | 1回目で成功 / 41720113(×10=417201130、一致) | 1回目で成功 / 41720113(一致) |
| 録画時間(実時間) | 2043.3秒 | 1072.1秒(**約52%**) |
| FpsMonitor | ─ | 中央値119.8Hz / 下位5% 119.6Hz / 最小98.6Hz |
| CPU平均(8vCPU) | ─ | 23.3%(p95 28.0%) |
| 落ちフレーム(20〜2020秒) | 20 (0.0%)、バースト11回 | 70 (**0.1%**)、バースト31回 |
| チャプター(ステージ開始) | 04:10 / 08:42 / 13:51 / 19:12 / 26:51 | 04:11 / 08:42 / 13:51 / 19:13 / 26:53 |
| 音声-30dB帯域 | 16.40kHz | 16.15kHz(8〜18kHzで0.5dB以内、20kHzは倍速側が高い) |

2倍速の31回のバーストのうち、2フレーム以上の大きなものは**すべてステージ開始時刻(04:11、08:42〜08:45、13:50〜13:54、19:13、26:53)=ステージのロード中**に集中しており、それ以外は散発的な1フレームのみ。`81_analyze`は「周期3.93秒、R=0.523」を出したが、バースト数が少なく実体はロード由来なので、reports/81型の機械的な妨害ではない。**通常ステージでも2倍速録画は破綻しない**(全6面でスコア一致・チャプター一致・処理落ちなし)。

### 5.1 NVENCの`-maxrate`が`-vsync 0`時に効いていない

生録画の映像ビットレートは等倍5.5Mbps(指定どおり)に対し、1.5倍20.7M・2倍28.4M・3倍36.6M・4倍43.9M・Hard2倍34.5Mbpsで、**倍速時は`-b:v`/`-maxrate`(録画時は倍率連動で2倍速10M/12M)を大きく超えていた**。`-vsync 0`でタイムスタンプを素通しするとNVENCのレート制御がフレームレートを正しく把握できていないと考えられる。画質面では損は無い(むしろcq 23で品質優先になっている)が、中間ファイルのサイズが大きくなる(2倍速Extra 364MB、Hard 4.5GB)。

## 6. 倍速時の「一定の音声遅れ」の原因調査(未解決・次フェーズへ)

§4の約0.2秒(実時間)の遅れについて、次の順に切り分けた。

1. **対照実験(決定打)**: 等倍速のまま倍速用の音声経路(専用シンク+`-sample_rate`付きPCM mov録音)だけを使う録画を行った(`FPS_LIMIT_TARGET_HZ=60.001`で倍速分岐に入れ、`SPEED_HACK_MULTIPLIER`は未設定。録音44101Hz、実質1.00002倍)。通常の等倍録画と照合すると**av_delta=+262〜277ms(一定)**で、**倍速用の音声経路に切り替えるだけで約0.26秒遅れる**ことが確定した(`raw/extra_1x_pcmpath.mp4`)。
2. **mux時の補正値**: 等倍(AAC m4a経路)は2回とも`delta=+0.592s`/`+0.601s`、倍速(PCM mov経路)は5回とも`delta=-0.023〜-0.004s`で、経路によって系統的に約0.6秒違う(フェーズ85の2倍速では`+0.624s`だったこともある)。
3. **フラッシュ+ビープ試験**(`scripts/87_flash_beep_sync_test.py`、reports/28と同じ方式): ローカル・インスタンスとも、等倍用と倍速用のffmpegコマンドの差は40〜80msのみ。映像側(120fps・`-vsync 0`)やコンテナ/コーデックの違いは主因ではない。
4. **DirectSound遅延プローブ**(`scripts/87_dsound_latency_probe/`・`scripts/87_measure_dsound_latency.py`): Play呼び出しの壁時計時刻と、録音上のクリックの絶対時刻の差を測った。専用シンク同士(44100/88200Hz)では差10ms以内。一方、既定シンク(auto_null)経由は1回目の測定で約0ms、同条件の再測定(`scripts/87_pulse_timestamp_variants.py`)では-552msと、**同じ条件でも約0.55秒の二値的なぶれ**が出た。

以上から、**`ffmpeg -f pulse`が付ける開始タイムスタンプ(`-copyts`のstart_time)自体に実行ごと・条件ごとに約0.5〜0.6秒のぶれがあり、mux時の補正(reports/28)がその分だけ誤る**、というのが現時点の最有力仮説である。これは倍速固有ではなく**等倍を含む既存パイプライン共通の潜在問題**で、等倍では最大約0.5秒の音ズレとして、倍速ではそれが復元時にN倍に拡大されて現れる。今回の倍速録画は結果的に等倍より0.36〜0.7秒(復元後)遅れた状態になっている。

**次フェーズの候補**: (a) pulse入力の開始時刻を「最初のパケットの受信時刻 − バッファ量」ではなく、停止時の壁時計時刻 − 録音サンプル数/レートで逆算する、(b) MODからゲーム開始時にクリック等の同期マーカーを鳴らし、映像側の既知イベントと突き合わせて補正する、(c) まずはffmpegの`pulse_audio_dec.c`のタイムスタンプ計算(`pa_stream_get_latency`とtimefilter)を読んでぶれの原因を特定する。

## 7. その他の観察

- **復元時の`dup`/`drop`**: x11grabのタイムスタンプは全倍率で「0msと2倍間隔」のペアで揺らぐ(2倍速: 0ms×195、8ms×395、17ms×194)。`47_descale`の`-r 60`はタイムスタンプ基準なので少数のdup/dropペアが生じる(2倍速Extraでdup 66/drop 63)。フレーム番号でPTSを振り直す方式(`setpts=N/(60*TB)`、`restored_idx/`)も試したところ、2倍速は同等、3倍速は落ち14.0%→9.0%に改善したが、**4倍速はx11grabが240fpsを維持できず約15%のフレームを取りこぼしており(映像206.7秒・音声242.6秒)、A/Vが大きくずれて使えない**。既定はタイムスタンプ基準のままとする。
- GPU使用率は全条件で低い(sm 9〜19%、enc 4〜10%)。ボトルネックはGPUではない。

## 8. 結論

- **2倍速録画はExtra・通常ステージ(全6面)とも実用品質**。g6f.2xlargeで試行1回目成功、スコア完全一致、復元後の落ちフレーム0.0〜0.1%(大きなものはステージロード中のみ)、音声帯域は等倍と0.5dB以内、録画時間は等倍の約52%。
- **1.5倍速は非推奨**。2倍速より映像が悪く(周期的な10フレーム停止)、音声も0.0756%ずつずれる(Wineの10ms周期の端数丸めと推定)。
- **3倍・4倍速はth15本体の単一スレッド性能が律速で処理落ちする**(復元後14〜20%のフレーム停止、BGMと画面が徐々にずれる)。音声(ALAC)は問題ない。
- **未解決**: 倍速録画の音声が等倍録画より一定量遅れる(2倍速で約0.45秒)。原因はffmpegのpulse入力の開始タイムスタンプのぶれ(等倍にも潜在)と推定。倍速を本番投入する前に解決が必要。

## 変更ファイル

- 新規: `scripts/87_run_speedup_batch.sh`(倍率ごとの録画バッチ、recorder/経由)
- 新規: `scripts/87_compare_timeline.py`(等倍録画と復元動画の映像・音声タイムライン照合、start_time考慮)
- 新規: `scripts/87_dsound_latency_probe/dslatency.cpp`, `scripts/87_dsound_latency_probe/build_mingw.sh`(DirectSound出力遅延プローブ)
- 新規: `scripts/87_measure_dsound_latency.py`(上記プローブで倍率・シンク構成ごとの遅延を測定)
- 新規: `scripts/87_flash_beep_sync_test.py`(等倍用/倍速用ffmpegコマンドのフラッシュ+ビープA/V試験)
- 新規: `scripts/87_pulse_timestamp_variants.py`(pulse入力の開始タイムスタンプの偏りをシンク・録音形式別に測定)
- 変更: `docs/titles/th15.md`, `docs/known-limitations.md`, `docs/gpu-recording.md`, `reports/README.md`, `AGENTS.md`
- 検証データ(ローカルのみ): `/mnt/cache3/sattori-th15-verify/phase87_speedup/`(`README.md`に視聴すべきファイルの一覧あり、計約15GB)
