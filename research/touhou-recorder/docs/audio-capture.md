# 音声キャプチャ仕様と運用ルール

このリポジトリにおける音声録音パイプライン、PulseAudio設定、トラブルシューティングをまとめます。

## 基本構成

- **オーディオサーバー**: PulseAudio
- **デフォルトシンク**: `auto_null`（モニターソース: `auto_null.monitor`）
- **キャプチャ方式**: ffmpegプロセスによるPulseAudioソース録音

## 重要な運用ルール

### 1. 映像と音声のプロセス分離および後mux補正

AWS等の実機環境では、映像（x11grab）と音声（pulse）を **必ず別々のffmpegプロセスで録画** し、実測した起動レイテンシ差分（`-copyts` + `-itsoffset`）を用いて録画完了後にmux（結合）します。

- 単一ffmpegプロセスでの映像・音声同時取り込みは、重複フレーム率の致命的な悪化を招きます。
- この分離・後mux処理は `scripts/23` および `recorder/`（CLI: `scripts/25`）の既定動作です（`--muxed-audio` オプションで旧方式への切替が可能）。

### 1.1 A/V同期は同期マーカーで決める（reports/88）

**`-copyts`のstart_timeの差だけでは音ズレを補正できない。** `ffmpeg -f pulse`のタイムスタンプは「読み取り時刻 − `pa_stream_get_latency()`」で、モニターソースではシンクのレイテンシも差し引かれ、Wine(dsound→winepulse)の出力遅延は含まれない。実測で等倍でも音が+0.09〜0.19秒遅れ、実行ごとにぶれていた(倍速では復元時にN倍)。

現在の`mux_audio_video()`は次の手順で音声の位置を決める:

1. `GameConfig.build_env()`が`SYNC_MARKER_TRIGGER`(Windows形式のパス)をゲームに渡す。録画パイプラインは音声録音開始の2秒後にそのファイルを置く(`recorder/sync_marker.py`)。
2. MOD(`mods/common/dsound_hook.cpp`。WASAPIのth06ncは`wasapi_hook.cpp`)が**ゲーム自身の音声デバイスから**xorshift32系列の±256(-42dBFS)ノイズを131072サンプル鳴らし、直前の壁時計時刻を`SYNC_MARKER played epoch=...`としてMODログに出す。
3. 録画後、音声を先頭20秒だけデコードしてPHAT相互相関でマーカーを探し(ピーク/中央値比20以上)、`音声先頭の真の時刻 = epoch − 位置`として映像のstart_timeとの差でmuxする。mux後にも照合して残差をログに出す(3ms超なら1回だけ再mux)。
4. 見つからなければ従来のstart_time方式にフォールバックする(`WARNING: 音声から同期マーカーを検出できませんでした`)。

新しいタイトルのMODには必ず`InstallDSoundHook(1.0)`(DirectSound以外なら相当するフック)を入れること。正否の検証には`scripts/88_av_truth_test.py`(光とクリックを同時に出す合成プローブ)を使う。

### 2. 並列実行時のPulseAudioシンク分離

複数インスタンスを並列実行する場合：
- `pactl load-module module-null-sink sink_name=<job>` でインスタンスごとに専用シンクを作成します。
- Wine起動時の環境変数に `PULSE_SINK=<job>` を指定します。
- **注意**: 専用シンクを1つでも追加すると、既存の `auto_null` は自動的にunloadされます。並列運用時は最初から専用シンクのみを使用する設計にしてください。

### 3. sattori-home-worker 残置シンクの事前確認・除去

本番ジョブ（`sattori-home-worker` 等）が作成した専用null-sinkは、サービス停止後も自動でunloadされずに残置されることがあります。

録画パイプラインは録音先を固定で `auto_null.monitor` と指定しているため（`recorder/config.py` の `PULSE_SOURCE`）、残置シンクの影響で `auto_null` が存在しない場合：
1. ゲームの音声出力が残置シンクに流れる。
2. 録音側のffmpegが存在しないデバイスを掴んで `Input/output error` で即終了する。
3. 映像は完走するものの音声ファイルが欠落し、試行全体が失敗扱いになる。

**対処手順**:
録画作業を開始する前（特にサービス停止直後）は必ず以下を確認・実行してください：

```bash
# auto_nullが存在するか確認
pactl list short sinks

# auto_nullがない場合、残置モジュールを特定してアンロード
pactl list modules short | grep null-sink
pactl unload-module <MODULE_ID>
```

### 4. 倍速録画（`MENU_TIME_SCALE < 1.0`）の音声帯域

倍速録画では `mods/common/dsound_hook.h` がDirectSoundのセカンダリバッファの再生周波数を倍率分スケールする（2倍速なら44100Hz→88200Hz、SE用の22050Hzバッファは44100Hzへ）。この「テープの早回し」状態の音声を劣化なく記録するには、**次の2点を両方**満たす必要がある（片方だけではどちらもほぼ同じ約10kHzのカットオフになり、症状が区別できない。`reports/86`）。

1. **ゲームプロセスの出力先PulseAudioシンクを倍速後のレートにする**（`recorder/instance.py` の `ensure_audio_sink()` が `PULSE_SINK=touhou_doublespeed_<game_id>` 用のnull-sinkを `rate=44100×N` で作成）。
   Wineの `winepulse.drv` はPulseAudioシンクのレートをそのままWASAPIミックスフォーマットに採用し、`dlls/dsound/mixer.c` はセカンダリバッファを**そのレートまでアンチエイリアス付きFIRでダウンサンプル**する。シンクが44100Hzのままだと圧縮空間の22.05kHz（等倍換算11kHz）で切られ、**録音側のサンプルレートをいくら上げても取り返せない**。
   MOD側でプライマリバッファの `SetFormat` をスケールしても意味がない（Wineは `DSSCL_WRITEPRIMARY` のときしか実ストリームを開き直さず、`DSSCL_WRITEPRIMARY` ではセカンダリが一切ミックスされない）。**この経路は原理的に使えないので試さないこと。**
2. **AACエンコード時に `-cutoff` を明示する**（`recorder/ffmpeg.py` の `aac_encode_args()`）。
   FFmpegのネイティブAACエンコーダの既定符号化帯域はビットレートだけで決まる**絶対周波数**（192kbps/2chで約19.3kHz）であり、サンプルレートに連動しない。88200Hz録音では19.3kHz＝等倍換算9.7kHzで切られる。ビットレートも倍率分スケールする（2倍速で384k）。

**倍速用シンクは録画終了時に必ず `remove_audio_sink()` で削除すること**（`recorder/pipeline.py` の `finally`）。残すと `module-always-sink` が `auto_null` を復活させず、**同じホストでの以後のネイティブ録画がすべて音声を録れなくなる**（上記「3.」と同じ症状）。

また `pactl` は必ず `LC_ALL=C` で実行すること（`recorder/instance.py` の `_pactl()`）。`GameConfig.build_env()` の `LANG=ja_JP.UTF-8` がそのまま渡ると出力ラベルが翻訳され（`Name:`→`名前:`）、英語前提のパースが静かに失敗する。

#### 倍率ごとの帯域上限とコーデック選択

MPEG-4 AACのサンプルレート表は最大96000Hzまでのため、3倍速以上ではFFmpegが**エラーを出さず黙って**96000Hzへリサンプルする。**復元後の帯域上限は「実レート ÷ 2（ナイキスト）÷ 倍率」**。

| 倍率 | 録音レート | AACの実レート | AAC時の復元後上限 | `audio_encode_args()`の選択 |
|---|---|---|---|---|
| 2倍速 | 88200Hz | 88200Hz | 22.05kHz（元素材44100Hzの全帯域＝実質制約なし） | AAC 384k + `-cutoff 44100` |
| 3倍速 | 132300Hz | 96000Hz | 16.0kHz | **ALAC（可逆）** |
| 4倍速 | 176400Hz | 96000Hz | 12.0kHz | **ALAC（可逆）** |

3倍速以上ではAACの上限を避けるためALAC（可逆・mp4にそのまま格納可）へ切り替える。倍速録画のmp4は「復元前の中間ファイル」なので可逆にしてもファイルサイズが増えるだけで、`scripts/47_descale_th20_slowmo.py` での復元時に通常のAAC 48000Hzになるため最終成果物の互換性は変わらない。

**Opusは使わないこと**（内部サンプルレートが48kHz固定で、3倍速では8kHz相当まで落ちる）。FLAC・PCMも高レート対応だが、FLAC in MP4は再生側の対応がまちまち。

#### 検証ツール

ゲームを起動せずにこの経路を測るには `scripts/86_dsound_probe/`（DirectSoundで対数スイープを鳴らす単体プローブ）と `scripts/86_analyze_audio_spectrum.py`（実効帯域の測定）を使う。手順は `reports/86` §1.3。

## 参照レポート

- `reports/10_phase10_audio_capture_verification.md`
- `reports/26_phase26_th08_aws_audio_capture_root_cause.md`
- `reports/28_phase28_th08_av_sync_fix.md`
- `reports/41_phase41_parallel_recording_pulseaudio_isolation.md`
- `reports/82_phase82_th15_environment_and_mod_bringup.md`
- `reports/85_phase85_th15_double_speed_recording_verification.md`
- `reports/86_phase86_doublespeed_audio_bandwidth_root_cause.md`
- `reports/88_phase88_av_sync_marker.md`
- `reports/89_phase89_speedup_all_titles_gpu.md`(th06ncのWASAPIレート偽装)
