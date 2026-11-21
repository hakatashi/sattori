# フェーズ10: 音声キャプチャの実現可能性検証

日付: 2026-07-15

## 背景

これまでの録画(フェーズ2・4)は`ffmpeg -f x11grab`のみで行っており、映像のみで音声トラックを含んでいなかった。実際のリプレイ動画化サービスとしては音声(BGM・効果音)のキャプチャも必須のため、現在の構成(Wine + Xvfb + ffmpeg)で音声を録画できるかを検証した。

## 環境確認

- `pactl info`でこのマシンのPulseAudioサーバーの状態を確認したところ、**Default Sink: `auto_null`**(実音声デバイスの無いヘッドレス環境向けのヌルシンク)、**Default Source: `auto_null.monitor`**であることを確認した
- 各Wineプレフィックス(`prefixes/th07-wined3d-gl`等)の`user.reg`を確認したところ、`Software\Wine\Drivers\winepulse.drv\devices\0,auto_null`が既に登録されており、**Wineは追加設定なしでPulseAudio経由の`auto_null`シンクに音声出力する**構成になっていることが分かった

## 検証: th07起動中の音声ストリーム確認

th07.exeをXvfb上で起動し、`pactl list short sinks`/`sink-inputs`を確認したところ、起動前は`auto_null`が`SUSPENDED`状態だったのに対し、**起動後は`RUNNING`に遷移し、sink-inputが1件登録される**ことを確認した。これはth07がタイトル画面のアトラクトモードBGMを実際に`auto_null`シンクへ出力していることを示す。

## 検証: 映像+音声同時録画

以下のコマンドで、映像(x11grab)と音声(pulse、`auto_null.monitor`)を同一のffmpegプロセスで同時に6秒間録画した。

```bash
ffmpeg -f x11grab -video_size 640x480 -framerate 60 -i :95 \
       -f pulse -i auto_null.monitor \
       -c:v libx264 -c:a aac output.mp4
```

- 出力ファイルに映像ストリーム(h264, 640x480, 60fps)と音声ストリーム(aac, 48000Hz, stereo)の両方が正しく含まれることを確認
- `ffmpeg -af volumedetect`で音声track解析したところ、**`mean_volume: -14.9 dB`, `max_volume: -0.1 dB`**(無音ではなく、実際に振幅のある音声信号が記録されている)ことを確認した

検証に使用した録画は`runs/manual_th07_audio_test/video.mp4`に保存した(6秒間、th07タイトル画面のアトラクトモード)。

## 結論

**現在計画している構成(Wine + Xvfb + ffmpeg)のまま、音声も追加のセットアップなしでキャプチャ可能**であることを確認した。既存の録画コマンドに`-f pulse -i auto_null.monitor`の音声入力を1行追加するだけで、映像・音声を同期して1本のmp4に収録できる。

## 既知の制約: 並列実行時は音声が分離できない

`auto_null`はこのマシンのPulseAudioサーバー**全体のデフォルトシンク**であるため、フェーズ5で検証したような複数インスタンス同時実行を行う場合、**全インスタンスの音声が同じシンクに混ざって記録されてしまい、インスタンスごとの音声を分離して録音できない**。

並列実行を本格的に運用する場合は、インスタンスごとに専用の仮想シンクを用意する対応が必要になる:

```bash
pactl load-module module-null-sink sink_name=thXX-a
# 該当インスタンスのwineプロセスに環境変数 PULSE_SINK=thXX-a を設定して起動
```

単一インスタンスでの録画(現状のPoCのスコープ)であれば、追加対応なしで問題ない。
