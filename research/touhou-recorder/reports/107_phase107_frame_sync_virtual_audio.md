# フェーズ107: フレーム同期キャプチャの仮想音声デバイス(th15・th12)

日付: 2026-11-16

## 結論

- **フレーム同期キャプチャで音声も録れるようになった。** MOD内の仮想音声デバイス(`mods/common/frame_sync_audio`)が、DirectSoundのセカンダリバッファの中身を写して仮想で再生し、映像の1フレームにつき735サンプル(44100Hz÷60)をミックスしてPCMへ書く。録画側は長さを映像と照合して結合する。`--frame-sync`では音声を既定で録る(`--no-audio`で無効)。
- 検証した全録画(フル尺4本を含む6本)で**音声の長さ=映像のフレーム数×735サンプル(端数0)**、BGMの補充の待ちのタイムアウトは0回。ミックスの負荷は1フレーム0.14〜0.15ms(処理速度への影響は誤差程度)。
- 実時間で録った既存の録画(th12 Extra `th12_01`、reports/102)との照合:
  - 同じ曲の中では、参照との音声のずれが0.1ms単位で一定。仮想デバイスの再生速度は正確。
  - 音量は参照とほぼ同じ(ラウドネス 参照-6.0 LUFS・候補-6.2 LUFS、RMS -9.15dB・-9.32dB、10分間)。
  - 同じ録画を3回繰り返すと、照合の値は小数点以下まで同じだった(決定的)。参照とのずれの増減は、参照側の性質(実時間録画では処理落ちで映像だけが遅れ、BGMは実時間で流れ続ける)で説明できる。
- **効果音は構造上、映像のフレームに揃う。** ゲームがフレームNの更新中に`Play`した音は、フレームNの音声区間の頭から鳴る。従来の録画で同期マーカー(reports/88)が担っていたA/V同期の補正は不要になる。
- **未確認**: 開発者の視聴による確認。試聴用クリップ: `/mnt/cache3/sattori-th12-verify/phase107/th12_01_framesync_audio_240s.mp4`(th12 Extraの240〜285秒)。

## 実装

### `mods/common/frame_sync_audio.cpp/.h`(新規)

`FRAME_SYNC_AUDIO`(出力PCMのWindows形式パス)が設定されたときだけ、`InstallFrameSyncHook()`の中で有効になる。`dsound_hook.cpp`の作成直後のコールバック(`g_dsoundBufferCreatedCallback`、reports/106で追加)でセカンダリバッファを登録し、vtableを差し替える。

| メソッド | 扱い |
|---|---|
| `Lock`[11] | 本物へ通す。オフセットを控える(`DSBLOCK_FROMWRITECURSOR`は仮想のwriteカーソルへ、`DSBLOCK_ENTIREBUFFER`は0から全体へ置き換える) |
| `Unlock`[19] | 本物へ通したうえで、書かれた範囲を写し(シャドウ)へコピーし、`unlockSeq`を増やす |
| `Play`[12]・`Stop`[18]・`SetCurrentPosition`[13] | 本物へ渡さず、仮想の状態(再生中か・ループか・位置)だけを更新する。本物のバッファは鳴らない |
| `SetVolume`[15]・`SetPan`[16]・`SetFrequency`[17] | 本物へも渡したうえで控える(`GetVolume`等は本物が答える)。[17]は`dsound_hook`のフックの上に重ねる |
| `GetCurrentPosition`[4]・`GetStatus`[9] | 仮想の値を返す。writeカーソルはplayの10ms先(実測で1764バイト=10ms、reports/106) |
| `QueryInterface`[0] → `IDirectSoundNotify::SetNotificationPositions`[3] | 本物へ渡さずに通知位置とイベントを控える(本物が実時間で通知しないように) |
| `Release`[2] | 参照が0になったら登録を外す |

ミックス(`FrameSyncAudioMixFrame()`、`frame_sync_hook`の`Present`フックから毎フレーム):

- 再生中の各バッファから735サンプルを読み、線形補間で44100Hzへ(22050Hzの効果音、`SetFrequency`)。8bitは`(v-128)/128`、16bitは`v/32768`、1chは左右同じ。
- 音量は`10^(volume/2000)`、パンは反対側を`10^(-|pan|/2000)`倍(DirectSoundの1/100 dB)。合計を16bitへ丸めて飽和させる。
- ループしないバッファは末尾で停止し、`DSBPN_OFFSETSTOP`の通知を出す。
- **BGMの通知**: そのフレームで仮想の再生位置が通知位置を越えたら`SetEvent`する。ミックスの後、そのバッファの`Unlock`が来るまで(最大`FRAME_SYNC_AUDIO_REFILL_WAIT_MS`、既定500ms)待ってから`Present`を続ける。補充スレッドは止まっている仮想の再生位置を読むので、実時間の揺らぎに関係なく毎回同じ区間を書く。
- `write=true`(そのフレームを取り込んだとき)だけファイルへ書く。映像と同じフレームだけ書くので長さは必ず一致する。

ログ: `FrameSyncAudio: enabled ...`、`buffer N bytes=... rate=...`、`stream buffer N Play/Stop at mixed_frame=...`(BGM)、`closed frames_written=... notifies=... refill_timeouts=...`。`stats`行に`audio_ms`(ミックスの時間)。

### `mods/common/frame_sync_hook.cpp`

- `Present`フックから`FrameSyncAudioMixFrame(captured)`を呼び、停止・中止時に`FrameSyncAudioClose()`。
- exeのIATの`CreateThread`を差し替え、仮想時計の開始後に作られたスレッドを追跡する(`FrameSync: CreateThread ...`、`thread tid=... exited frames=...`)。`FRAME_SYNC_THROTTLE_WHILE_THREADS=1`なら、それが生きている間だけ実時間60Hzの上限を戻す(読み込み中に動画上で待ちが伸びるのを防ぐ案。既定は無効、§3)。`FRAME_SYNC_THREAD_MAX_MS`(既定10000)より長く生きるスレッドは読み込みではないとみなして外す。

### 録画側(`recorder/framesync.py`)

- `--no-audio`でなければ`FRAME_SYNC_AUDIO=<出力>.audio.pcm`を渡し、映像は`<出力>.video.mp4`へ書く。
- 停止後、PCMの大きさが「映像のフレーム数×2940バイト」ちょうどかを照合し(`[FRAME_SYNC] 音声: ... 映像との一致=OK`)、`ffmpeg -f s16le -ar 44100 -ac 2`でAAC 192kへ結合する。一致しなければ試行を失敗にする。中間ファイルは結合後に消す(`FRAME_SYNC_KEEP_INTERMEDIATE=1`で残す)。
- `RecordingOptions.frame_sync`は`no_audio`を強制しなくなった。

## 1. 検証

```bash
bash mods/common/build_mingw.sh th15 && bash mods/common/build_mingw.sh th12
FRAME_SYNC_KEEP_INTERMEDIATE=1 scripts/105_run_frame_sync.sh th15 a1_extra_short th15_09.rpy 60
SUMMARY_BIN_FRAMES=7200 scripts/105_run_frame_sync.sh th12 a2_th12_01_extra th12_01.rpy
python3 scripts/87_compare_timeline.py /mnt/cache3/sattori-th12-verify/102/seq/area_full.mp4 \
  /mnt/cache3/sattori-th12-verify/phase105/a2_th12_01_extra/video.mp4 \
  --anchors 20,60,120,180,240,300,360,420,480,540,600,660 --search 20
```

| ラベル | タイトル・リプレイ | 動画 | 音声の照合 | 補充の待ちのタイムアウト | 通知 | 処理速度 | ミックス |
|---|---|---|---|---|---|---|---|
| a1 | th15 Extra(`th15_09`)、動画60秒ぶん | 4543フレーム | 13356420バイト=4543フレームぶん | 0 | 139回 | 1.27倍速 | 0.15ms |
| a2 | th12 Extra(`th12_01`)フル | 43087フレーム | 一致 | 0 | 2788回 | 3.30倍速 | 0.14ms |
| a3 | 同上(スレッド記録つき) | 43079フレーム | 一致 | 0 | – | 3.30倍速 | – |
| a4 | 同上、`FRAME_SYNC_THROTTLE_WHILE_THREADS=1` | 43071フレーム | 一致 | 0 | – | 3.29倍速 | – |
| a5 | th15 Extra(`th15_08`)フル | 47823フレーム | 140599620バイト=47823フレームぶん | 0 | 1547回 | 1.12倍速 | 0.19ms |
| a6 | th12 Hard全6面(`th12_02`) | 103679フレーム | 304816260バイト=103679フレームぶん | 0 | 6788回 | 3.36倍速 | 0.13ms |

a1のPCM(75.7秒)は、タイトル画面のBGM(4〜14秒)、ロード中の無音(14〜17秒)、ステージのBGM(17秒〜)の順で、0.1秒窓で-60dB未満の区間はロード中の無音だけだった。0.05%のサンプルが飽和していた(本物のミキサーと同じく、ゲームの音量が大きい場面で起きる)。

### 1.1 実時間録画との照合(th12 Extra `th12_01`)

参照は reports/102 の`/mnt/cache3/sattori-th12-verify/102/seq/area_full.mp4`(ローカル、Xvfb、等倍、同期マーカーでmux、`D3DX_AREA_FILTER=1`)。a2の結果:

| t_ref(秒) | 20 | 60 | 120 | 180 | 240 | 300 | 420 | 480 | 540 | 600 | 660 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| video_off | +1.250 | +1.233 | +1.200 | +1.183 | +1.150 | +1.117 | +1.067 | +1.050 | +1.017 | +0.983 | +0.950 |
| audio_off | +1.2863 | +1.2863 | +1.2864 | +1.2864 | +1.2864 | +1.1231 | +1.1231 | +1.1231 | +1.2231 | +1.2231 | +1.2236 |

(360秒は相関が0.34と低く外れ値)

- **映像**: 参照は11分で0.3秒、候補より遅れていく。参照(実時間録画)は処理落ちでゲームの進行が遅れるため。候補は1フレーム=1ゲームフレームなので遅れない。
- **音声**: 同じ曲の中ではずれが0.1ms単位で一定。参照のBGMは実時間で流れ続けるので、参照の映像が遅れるぶん、参照の中で映像とBGMがずれていく(av_deltaが36→136msと増えるのはこのため)。候補ではBGMもゲームのフレームに固定されている。
- 曲が変わる(a3のログでBGMの`Play`は動画フレーム726と15475)と、ゲームが新しい曲を鳴らし始めた時点でずれが揃い直る。
- 540秒以降の+0.1秒の段差: `87_compare_timeline.py`(参照を先頭から通しでデコード)では506〜510秒の間でちょうど0.1000秒の段差が出たが、参照を488秒から切り出してデコードし0.5秒刻みで照合すると488〜513秒で段差は無かった(+1.3858秒で一定)。デコードの仕方で出たり消えたりし、ちょうど100ms(PulseAudioからの読み取りのかたまり)であることから、参照の音声ファイルのタイムスタンプの欠けと見ている。候補は1フレーム735サンプル単位で決定的にミックスするので、0.1秒を挟む経路が無い。
- 同じ条件で3回録った候補(a2・a3・a4)は、照合の値(av_delta)が小数点以下まで同じだった。メニューの区間だけ実時間で進むため開始位置(video_off)は録画ごとに変わる。

### 1.2 フル尺(負荷の高い場面での安定性)

```bash
scripts/105_run_frame_sync.sh th15 a5_th15_extra_full th15_08.rpy
SUMMARY_BIN_FRAMES=7200 scripts/105_run_frame_sync.sh th12 a6_th12_hard_full th12_02.rpy
```

- 2本とも試行1回目で完走し、フレーム数・音声の長さ・スコア(th15 110347900、th12 183240710)がすべて一致した。補充の待ちのタイムアウトは0回。
- 処理速度は音声なし(reports/105)の th15 Extra 1.17倍速 → 1.12倍速、th12 Hard 3.50倍速 → 3.36倍速で、4%前後遅くなった。ミックス自体は0.13〜0.19msで、残りは補充を待つ間(0.25〜0.5秒ごと)の停止と見られる。録画ごとのぶれ(reports/105で同条件のth12 Extraが3.47〜3.74倍速)と同程度の差。

## 2. 読み込みスレッドの影響(reports/104の懸念)

reports/104では「読み込みを別スレッドが実時間で行う間もゲームが速く進み、動画上で待ちが伸びる」ことを懸念した。a3でスレッドの生存期間を記録した(th12 Extra):

```
CreateThread tid=316 start=0x6E4C8 frame=2   → exited frames=27(2..29)    real_ms=467
CreateThread tid=324 start=0x6E4C8 frame=29  → exited frames=159(29..188) real_ms=2637
stream buffer 51 Play at mixed_frame=198   (タイトル画面のBGM)
CreateThread tid=328 start=0x6E4C8 frame=479 → exited frames=2            real_ms=17
CreateThread tid=332 start=0x6E4C8 frame=629 → exited frames=93(629..722) real_ms=536
stream buffer 52 Play at mixed_frame=726   (ステージのBGM)
stream buffer 53 Play at mixed_frame=15475 (ボスのBGM)
```

th12では読み込みスレッド(`+0x6E4C8`)は**メニューからリプレイ開始までの間だけ**作られ、その区間はもともと実時間60Hzで進めている(上限解除はキー操作の後)。リプレイ中の曲の切り替えはメインスレッドが同期的に行う。`FRAME_SYNC_THROTTLE_WHILE_THREADS=1`のa4はa3と結果が同じだった。今のところ対策は不要だが、他タイトル(ステージ間で読み込みスレッドを使うもの)のためにオプションとして残す。

## 3. 未解決・次の作業

- **開発者の視聴による確認**(試聴用クリップは冒頭に記載)。
- 補間は線形。22050Hzの効果音で折り返し雑音が出うる。視聴で問題があれば帯域制限付きの補間にする。
- ミックスの式は標準的なDirectSoundの定義(1/100 dB)で、Wine(`pow(2, v/600)`)とは-10000付近でわずかに違う。大音量のときの飽和は本物と同じく起きる。
- 対応はth15・th12のみ。同じ音声エンジンのタイトル(th10〜th14、th128、th20)は同じ方式で動く見込みだが、MODへの組み込みと確認が要る。th06〜th09はDirectSoundの使い方が違う可能性がある(DSOUND_PROBEで調べる)。th06ncはWASAPI。
- クラウドでの実測、他タイトルへの展開(reports/105 §4)。

## 生成物

- コード: `mods/common/frame_sync_audio.cpp/.h`(新規)、`mods/common/frame_sync_hook.cpp/.h`、`recorder/framesync.py`・`recorder/options.py`、`scripts/105_frame_sync_summary.py`(`audio_ms`)
- 動画: `/mnt/cache3/sattori-th15-verify/phase105/a1_extra_short`・`a5_th15_extra_full`、`/mnt/cache3/sattori-th12-verify/phase105/a2_th12_01_extra`〜`a4_th12_01_throttle`・`a6_th12_hard_full`、試聴用`/mnt/cache3/sattori-th12-verify/phase107/`
