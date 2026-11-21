# フェーズ108: 仮想音声デバイスの効果音抜けの修正(DuplicateSoundBuffer)

日付: 2026-11-16

## 結論

- reports/107の録画を開発者が視聴し、映像・音声とも等倍とほぼ区別できない品質だったが、**一部の効果音が抜けている**こと、**同じ効果音が重ならない**ことが指摘された(下表)。
- 原因: ゲームは同じ効果音を重ねて鳴らすために、起動時に効果音バッファを`IDirectSound8::DuplicateSoundBuffer`(vtable[5])で複製している(th15・th12とも11本。1つの効果音を最大3重まで)。仮想音声デバイスは`CreateSoundBuffer`で作られたバッファしか把握しておらず、**複製で鳴らした効果音は本物のDirectSoundへ素通しになり、録音に入っていなかった**。
- 修正: `dsound_hook`で`DuplicateSoundBuffer`をフックし、仮想音声デバイスは複製を元バッファと**写し(シャドウ)を共有する**別のバッファとして登録する。修正後の3本で、把握外のバッファでの再生は0回。
- 修正前後の音声を時刻合わせして差し引くと、**指摘のうち確信度が高・中の場面ではすべて、修正後にだけ鳴る音があった**。確信度が低の2件のうち、th12 `th12_01`の4:06は残差が小さく、もともと抜けていなかったとみられる。

| 動画(修正前) | 時刻 | 内容(視聴による推定) | 確信度 | 修正前後の残差(OLDの音量比) |
|---|---|---|---|---|
| th15 Extra `a5` | 3:28 | ボムの光弾の爆発 | 高 | **-0.9dB**(3:28.2) |
| 同 | 8:57 | 同 | 高 | -4.1dB |
| 同 | 9:37 | 同 | 高 | -3.9dB(9:37.8) |
| 同 | 9:43 | 同 | 高 | -4.5dB(9:43.3) |
| 同 | 2:27 | スペルカード撃破 | 中 | -4.1dB(2:27.3) |
| th12 Extra `a2`(`th12_01`) | 4:06 | 喰らいボム時の被弾 | 低 | -14.2dB(変化小) |
| 同 | 4:45 | スペルカード撃破の打撃音 | 中 | -7.5dB(4:44.1) |
| 同 | 7:53 | UFO撃破 | 低 | -2.7dB(7:51.2) |
| 同 | 0:18 | 同じ効果音の連続(重ならない) | – | -10.6dB(0:20.0) |
| th12 Hard `a6` | 9:46 | 雲山の拳の激突 | 高 | **-1.5dB**(9:47.4) |
| 同 | 24:08 | スペルカード撃破の打撃音 | 高 | -4.9dB(24:08.1) |

残差は、0.1秒窓の「新−旧」のRMSを旧の同じ窓のRMSで割ったもの。差し引きの基準(プレイ中の中央値)は-15〜-18dB程度(AACの符号化誤差)なので、-5dBを超えれば旧録画の音量に匹敵する音が丸ごと抜けていたことを意味する。指摘の場面以外にも、th12 `th12_01`の6:11〜6:28に1秒おきに鳴る効果音(残差+0〜+3dB)など、多数の抜けが戻っている。

## 調査

reports/106の記録(`/mnt/cache3/sattori-th1{5,2}-verify/phase106/rt_hard/`)で、5秒ごとに「把握済みバッファへの呼び出し数」と「スレッド側で数えた全呼び出し数」を比べると、差が常に5の倍数(例: 75、50)で一致しなかった。効果音1回の「`Stop`・`SetCurrentPosition`・`SetPan`・`SetVolume`・`Play`」の5回に当たり、把握していないバッファで効果音が鳴っていた。

`dsound_hook`に`DuplicateSoundBuffer`のフックを足してプローブで記録し直すと(`scripts/106_run_dsound_probe.sh th12 rt_hard_dup th12_02.rpy 90`)、起動時に音声の初期化スレッド(呼び出し元`th12.exe+0x54683`)が11本を複製していた(#2→#3、#5→#6、#9→#10、#24→#27・#30、#25→#28、#26→#29、#42→#45、#46→#47、#48→#49、#60→#61)。複製を登録すると、差は全19窓で0になった。90秒の間に#6が67回、#30が3回鳴っていた。

## 修正

- `mods/common/dsound_hook.cpp`: `IDirectSound8`のvtable[5](`DuplicateSoundBuffer`)をフックし(`HookDuplicate()`、`DirectSoundCreate8`と`HookDirectSoundObject`の両経路)、成功直後に`g_dsoundBufferDuplicatedCallback(original, duplicate, returnAddress)`を呼ぶ。
- `mods/common/frame_sync_audio.cpp`:
  - 写しを参照カウント付きの`Shadow`にし、複製(`OnBufferDuplicated()`)は元の写しを共有する(DirectSoundの複製はメモリを共有するので、どちらへの書き込みも両方に反映される)。形式・音量・パン・周波数は元から受け継ぎ(Wineの実装と同じ)、再生位置0・停止状態から始める。
  - 把握外のバッファで`Play`されたら`WARNING Play on unknown buffer`を出し、停止時の集計に`unknown_plays`を出す。
- `mods/common/dsound_probe_hook.cpp`: 複製を`buffer #N DUPLICATED from #M`として記録・集計する。

## 検証

```bash
bash mods/common/build_mingw.sh th15 && bash mods/common/build_mingw.sh th12
scripts/105_run_frame_sync.sh th15 b1_th15_extra_full th15_08.rpy
SUMMARY_BIN_FRAMES=7200 scripts/105_run_frame_sync.sh th12 b2_th12_01_extra th12_01.rpy
SUMMARY_BIN_FRAMES=7200 scripts/105_run_frame_sync.sh th12 b3_th12_hard_full th12_02.rpy
python3 scripts/108_audio_residual.py <修正前.mp4> <修正後.mp4> --times 3:28,8:57,...
```

| ラベル | 内容 | フレーム数・音声の照合 | スコア | 複製 | unknown_plays | 補充タイムアウト | 処理速度 |
|---|---|---|---|---|---|---|---|
| b1 | th15 Extra `th15_08` | 47863、一致 | 110347900 一致 | 11 | 0 | 0 | 1.14倍速 |
| b2 | th12 Extra `th12_01` | 43071、一致 | 195699630 | 11 | 0 | 0 | 3.21倍速 |
| b3 | th12 Hard `th12_02` | 103679、一致 | 183240710 一致 | 11 | 0 | 0 | 3.40倍速 |

- `scripts/108_audio_residual.py`: 修正前後はゲームの進行が決定的に同じなので、音声を相互相関でサンプル単位に合わせて差し引く。ずれは3か所で測って完全に一致した(th15 +0.71667秒=31605サンプル、th12 `th12_01` +0.08333秒、th12 Hard +0.01667秒=735サンプル。メニュー区間だけ実時間で進むので録画ごとに違う)。残差が大きい区間はすべて新録画の方が大きかった(音が増えた)。冒頭のメニュー区間(〜0:13)はBGMの位置が録画ごとに違うので無視する。
- ラウドネス(30〜630秒、th12 `th12_01`): 参照-6.0 LUFS、修正前-6.2、修正後-6.1。
- `scripts/108_compare_scenes.py`で参照(実時間録画)との相関も見たが、BGMが支配的でばらつきが大きく、修正の効果の判定には使えなかった(参照は実時間で進むので、BGMと効果音の相対位置が候補と少しずつ違う)。対応時刻を求めるのには使える。

## 視聴比較用の対応時刻

正常な録画(参照)は従来方式で録った音声つきの録画。いずれも同じリプレイであることを映像の照合(MAD 0.2〜1.6)で確かめた。

| 対象 | 参照(正常な録画) | 修正前 | 参照の時刻 | 修正後 |
|---|---|---|---|---|
| th15 Extra | `/mnt/cache3/sattori-th15-verify/phase91_cpu_slowmo/delivery/th15_extra_20hz_4x_delivery.mp4`(`c7i.4xlarge`の1/3倍速を等倍へ戻した配信版、本番採用の品質) | `.../phase105/a5_th15_extra_full/video.mp4` | 2:27→2:14.7、3:28→3:15.7、8:57→8:45.0、9:37→9:25.0、9:43→9:31.0 | `.../phase105/b1_th15_extra_full/video.mp4`(修正前+0.72秒) |
| th12 Extra `th12_01` | `/mnt/cache3/sattori-th12-verify/102/seq/area_full.mp4`(ローカル・等倍、reports/102) | `.../phase105/a2_th12_01_extra/video.mp4` | 0:18→0:16.8、4:06→4:04.9、4:45→4:43.9、6:12→6:10.9、7:53→7:52.0 | `.../phase105/b2_th12_01_extra/video.mp4`(修正前+0.08秒) |
| th12 Hard `th12_02` | `/mnt/cache3/sattori-th12-verify/th12-verify-c7a-2xlarge.mp4`(ファイル名からAWS `c7a.2xlarge`での等倍録画とみられる。出典レポートは特定できず) | `.../phase105/a6_th12_hard_full/video.mp4` | 9:46→9:44.8、24:08→24:06.8 | `.../phase105/b3_th12_hard_full/video.mp4`(修正前+0.02秒) |

## 視聴確認(修正後)

- 開発者が修正後の録画(b1〜b3)を視聴し、**指摘した効果音の抜け・違和感はすべて修正されていた**。
- 全編を通した確認でも、音声・映像とも開発者が認識できる範囲では実機の等倍再生と区別がつかず、滑らかで完璧な動画だった。
- これによりreports/107で未実施だった視聴確認も完了(フレーム同期キャプチャの音声は、th15 Extra・th12 Extra・th12 Hardで視聴合格)。他タイトル・クラウド実測は未確認。

## 未解決

- 他タイトルの音声エンジンでも複製を使うかは未確認(同じフックで対応できる)。

## 生成物

- コード: `mods/common/dsound_hook.cpp`、`mods/common/frame_sync_audio.cpp`、`mods/common/dsound_probe_hook.cpp/.h`、`scripts/108_audio_residual.py`・`scripts/108_compare_scenes.py`(新規)
- 動画: `/mnt/cache3/sattori-th15-verify/phase105/b1_th15_extra_full/`、`/mnt/cache3/sattori-th12-verify/phase105/b2_th12_01_extra/`・`b3_th12_hard_full/`
- 記録: `/mnt/cache3/sattori-th12-verify/phase106/rt_hard_dup/`
