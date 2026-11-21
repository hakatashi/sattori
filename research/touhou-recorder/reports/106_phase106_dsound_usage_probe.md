# フェーズ106: th15・th12のDirectSoundの使い方の調査(フレーム同期キャプチャの音声対応の準備)

日付: 2026-11-16

## 結論

- th15・th12は**同じ音声エンジン**だった。効果音は起動時に読み込む静的バッファ(th15は66本、th12は約49本)を、**メインスレッドから**「`Stop`→`SetCurrentPosition(0)`→`SetPan`→`SetVolume`→`Play(ループなし)`」で鳴らす。BGMは**4秒のストリーミングバッファ1本**を、**再生位置通知(`IDirectSoundNotify`)と専用の補充スレッド**で流す。
- 補充スレッドは通知イベントを`MsgWaitForMultipleObjects`で待ち、起きると`GetCurrentPosition`で再生位置を読んで、**直前に再生し終えた区間**(th15は0.5秒=88200バイト、th12は0.25秒=44100バイト)を`Lock`/`Unlock`で書き直す。先読みは3.5秒(th15)/3.75秒(th12)ある。
- `SetFrequency`は使われない。DirectSoundのタイマー(`timeSetEvent`)も使われない。
- したがって、reports/104の案A(MOD内の仮想音声デバイス)は**DirectSoundのバッファ単位の差し替え**で実現できる: バッファの中身を写しておき、再生・停止・位置・音量・パンを仮想の状態として持ち、フレームごとに735サンプル(44100÷60)をミックスする。BGMの通知はミックスする側が仮想の再生位置に合わせて`SetEvent`し、補充スレッドの書き込みを待ってから先へ進めば、実時間に依存せずに決定的に流せる。

## 方法

診断用フック`mods/common/dsound_probe_hook.cpp/.h`を新規に作った(`DSOUND_PROBE=1`のときだけ有効)。

- `dsound_hook.cpp`の`MyCreateSoundBuffer`に、作成直後のコールバック`g_dsoundBufferCreatedCallback`(バッファ・`DSBUFFERDESC`・プライマリか・呼び出し元)を追加した。
- プローブはセカンダリバッファのvtable(`QueryInterface`[0]・`Release`[2]・`GetCurrentPosition`[4]・`GetStatus`[9]・`Lock`[11]・`Play`[12]・`SetCurrentPosition`[13]・`SetVolume`[15]・`SetPan`[16]・`Stop`[18]・`Unlock`[19])と、`QueryInterface`で得た`IDirectSoundNotify`の`SetNotificationPositions`[3]を記録用に差し替える。exeのIATの`WaitForSingleObject`・`Sleep`・`CreateThread`も記録する。
- 各バッファ・各メソッドの最初の24回は詳細(引数・スレッド・呼び出し元RVA・時刻)を、以後は5秒ごとの回数を出す。初めて見たスレッドは`NtQueryInformationThread(ThreadQuerySetWin32StartAddress)`で開始アドレスを出す。
- th15・th12のMODで`InstallDSoundHook()`の直後に`InstallDSoundProbeHook()`を呼ぶ。

```bash
bash mods/common/build_mingw.sh th15 && bash mods/common/build_mingw.sh th12
scripts/106_run_dsound_probe.sh th15 rt_hard th15_07.rpy 150   # 通常の録画(実時間)、150秒
scripts/106_run_dsound_probe.sh th12 rt_hard th12_02.rpy 150
objdump -d --start-address=0x476e60 --stop-address=0x476f60 -M intel games/th15/th15.exe  # 補充スレッドの待ち
```

ログは`/mnt/cache3/sattori-th1{5,2}-verify/phase106/rt_hard/th1{5,2}_autoplay.log`。

## 結果

### スレッド

| th15 | th12 | 役割(観測から) |
|---|---|---|
| tid 264(`th15.exe+0x9269D`=エントリ) | tid 264(`th12.exe+0x6E81D`) | メインスレッド。効果音の`Play`等はすべてここ(th15 882件・th12 901件の詳細行がすべてtid 264)。BGMの切り替え(旧バッファの`Stop`・`Release`、新バッファの作成・最初の充填・`Play`) |
| tid 300(`+0x75650`) | tid 296(`+0x530E0`) | 音声の初期化。プライマリバッファ、無音の32KBループバッファ(#1)、効果音バッファを作って中身を書く |
| tid 328(`+0x76E60`) | tid 324(`+0x548A0`) | **BGMの補充スレッド**。`MsgWaitForMultipleObjects`(th15はIAT `0x4be218`、th12は`0x498088`)で通知イベントを待つ。exeのIATの`WaitForSingleObject`・`Sleep`は呼ばない |
| tid 312ほか(`+0x90A58`、複数回作られる) | tid 320ほか(`+0x6E4C8`) | 読み込み用と見られる(最初のBGMバッファをここで作る) |

### バッファ

| 種類 | th15 | th12 |
|---|---|---|
| プライマリ | #0 | #0 |
| 無音のループ(`flags=0x8008`、32768バイト、44100Hz・2ch・16bit、0.186秒) | #1。起動時に1回`Play(LOOPING)` | #1。同じ |
| 効果音(`flags=0x80C8`=GLOBALFOCUS\|CTRLVOLUME\|CTRLPAN\|LOCSOFTWARE) | #2〜#67。22050Hz/44100Hz、1/2ch、8/16bitが混在 | #2〜#50。ほぼ44100Hz・1ch・16bit |
| BGM(`flags=0x18188`=GETCURRENTPOSITION2\|GLOBALFOCUS\|CTRLPOSITIONNOTIFY\|CTRLVOLUME\|LOCSOFTWARE) | 705600バイト(44100Hz・2ch・16bit、4.000秒)。曲ごとに作り直す(#68〜#71) | 同じ大きさ(#51〜#54) |
| BGMの通知 | 8か所(88199, 176399, …, 705599。0.5秒ごと)、**1つのイベントを共有** | 16か所(44099, 88199, …。0.25秒ごと)、1つのイベントを共有 |

### 効果音の鳴らし方(150秒ぶん)

- th15: `Play` 6821回、`Stop` 7215回、`SetCurrentPosition` 6826回、`SetVolume` 6820回、`SetPan` 6817回。1回の発音は常に`Stop`→`SetCurrentPosition(0)`→`SetPan`→`SetVolume`→`Play(flags=0)`で、同じバッファの多重再生はしない(鳴っていれば頭から鳴らし直す)。最も多いのは#2(2855回)。
- th12: ほぼ同じ(`Play` 6407回、`SetPan` 8262回)。#46だけ`Play(LOOPING)`(4回)で、ループする効果音がある。
- 音量は-40〜-1925(1/100 dB)など。パンは-52等の小さい値。メインスレッドは一部の効果音バッファに`GetStatus`も使う。

### BGMの流し方(th15の#69の例)

```
t=3.703 tid=264 GetStatus -> 0 / SetCurrentPosition 0 / Lock off=0 bytes=705600 / Unlock  (4秒ぶんを先に全部書く)
t=3.721 tid=264 SetVolume 0 / Play flags=0x1(LOOPING)
t=4.210 tid=328 GetCurrentPosition play=88200 write=89964 / GetStatus -> 0x5 / Lock off=0 bytes=88200 / Unlock / GetCurrentPosition
t=4.710 tid=328 GetCurrentPosition play=176400 ...      / Lock off=88200 bytes=88200 / Unlock
t=5.210 tid=328 ...                                     / Lock off=176400 bytes=88200 / Unlock
```

通知のたびに、補充スレッドは「再生位置の直前の0.5秒」を書き直す。`write`カーソルは`play`の1764バイト(10ms)先。曲の切り替えでは、メインスレッドが旧バッファを`Stop`・`SetCurrentPosition(0)`して`Release`し、同じ形式の新バッファを作る。th12では曲の終わり等で`SetVolume`が26回呼ばれる(フェード)。

## 仮想音声デバイスの設計(次フェーズで実装)

フレーム同期キャプチャのときだけ、セカンダリバッファを次のように扱う。

1. **中身の写し**: `Unlock`のたびに書かれた範囲を、MODが持つ写し(シャドウ)へコピーする(`Lock`/`Unlock`自体は本物へ通す)。
2. **状態は仮想で持つ**: `Play`(ループの有無)・`Stop`・`SetCurrentPosition`・`SetVolume`・`SetPan`・`SetFrequency`は本物へ渡さずに状態だけ更新し、`GetCurrentPosition`・`GetStatus`は仮想の値を返す(`write`は`play`+10ms)。`SetNotificationPositions`も本物へ渡さず(本物が実時間で通知しないように)、位置とイベントを控える。
3. **ミックス**: `Present`ごとに、再生中の全バッファから735サンプルをミックスする(形式の変換、22050Hzの補間、音量`10^(v/2000)`、パン)。44100Hz・2ch・16bitのPCMをファイルへ書けば、映像のフレームと音声のサンプルが厳密に対応する。
4. **BGMの通知**: ミックスで仮想の再生位置が通知位置を越えたら`SetEvent`し、補充スレッドの`Unlock`が来るまで(上限を設けて)待つ。先読みが3.5秒あるので待たなくても破綻しにくいが、待てば実時間の揺らぎに左右されない。

## 生成物

- コード: `mods/common/dsound_probe_hook.cpp/.h`(新規)、`mods/common/dsound_hook.cpp`(作成直後のコールバック)、`mods/th15_replay_autoplay/dllmain.cpp`・`mods/th12_replay_autoplay/dllmain.cpp`(`InstallDSoundProbeHook()`)、`scripts/106_run_dsound_probe.sh`(新規)
- ログ: `/mnt/cache3/sattori-th15-verify/phase106/rt_hard/`、`/mnt/cache3/sattori-th12-verify/phase106/rt_hard/`
