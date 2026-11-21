# フェーズ89: 倍速録画の全タイトル展開(g6f.2xlarge・GPU描画)と、th06〜08の3・4倍速

## 背景と目的

reports/85〜87でth15の2倍速録画が実用品質に達し、reports/88で残課題だった音ズレを同期マーカーで解決した。本フェーズでは、過去に録画検証済みの他タイトルでも同様に2倍速録画が可能かを、**GPU描画・GPU録画(NVENC)を前提に**AWSのg6f.2xlarge(us-west-2スポット)で検証した。描画負荷の低いth06〜th08は3・4倍速も試した。

対象: th06 / th06nc / th07 / th08 / th09 / th10 / th11 / th12 / th128 / th15 / th20(th06cはGPU描画・低速録画とも未検証のため対象外)。

## 1. 環境

| 項目 | 値 |
|---|---|
| インスタンス | g6f.2xlarge スポット×2台(us-west-2c、`<INSTANCE_ID>`=A、`<INSTANCE_ID>`=B)。d/b/aは容量不足。検証後にterminate・スポットリクエスト(`<SPOT_REQUEST_ID>`/`<SPOT_REQUEST_ID>`)もcancel済み |
| AMI | `<AMI_ID>`(Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04) 20260922)、gp3 150GiB |
| 構築 | `scripts/89_setup_gpu_instance.sh`(新規、reports/87 §1.1をスクリプト化)。GRIDドライバ(`latest/`)、`NVIDIA L4-6Q` |
| 録画 | `scripts/89_run_speedup_batch.sh`(新規、reports/87のバッチのタイトル汎用版)。既定引数 `--gpu-display --gpu-encode`、th128/th20は`--thprac`、th08は`--capture-window-id`を追加 |
| 集計 | `scripts/89_summarize_speedup.py`(新規)。復元は`scripts/47_descale_th20_slowmo.py --target-hz 60N`、落ちフレームは`scripts/81_analyze_stutter_periodicity.py`(15秒〜末尾45秒手前) |

分担: A=th15・th06nc・th06〜08(2〜4倍速)、B=th09〜th20。比較用に同じリプレイ・同じ構成で等倍(1倍速)も録画した。

## 2. 各タイトルへの倍速化の実装

| タイトル | ゲームの時間源 | 倍速化の手段 | 音声 |
|---|---|---|---|
| th06 | vpatch(`vpatch_th06.dll`)がフレームレートを制御 | `vpatch.ini`の`GameFPS`を60Nに書き換え(`recorder/instance.py`の`_apply_vpatch_game_fps()`、新規)+QPC偽装 | DirectSound(`dsound_hook`、今回MODに追加) |
| th07/th08 | QueryPerformanceCounter | `speed_hack_hook`(QPC偽装、今回MODに追加) | 同上(今回追加) |
| th09/th10/th12/th128/th20 | QueryPerformanceCounter | `speed_hack_hook`(今回追加)+既存のPresent上限 | 既存の`dsound_hook` |
| th11 | QueryPerformanceCounter | `speed_hack_hook`(今回追加) | `dsound_hook`(今回追加) |
| th15 | QueryPerformanceCounter | 既存(reports/85) | 既存 |
| th06nc(64bit・DXライブラリ) | DXライブラリが`GetProcAddress`でQPCを取得 | `GetProcAddress`フックでQPCを偽装版に差し替え(`WrapQueryPerformanceCounterForSpeedHack()`) | **WASAPI**(新規`mods/common/wasapi_hook.cpp`) |

- ローカル(Xvfb・CPU描画)の短尺試験で、th06/07/08/09/10/11/12はQPC偽装(th06はvpatch)だけで120Hzに到達することを先に確認した(`/mnt/cache3/sattori-speedup-local-p89/`)。`speed_hack_hook`には`SPEED_HACK_TIMERS`(`tgt`/`tick`)でtimeGetTime・GetTickCountも偽装できる機能を足したが、今回のタイトルでは不要だった。
- **th06ncの音声はWASAPI**だった。`TH06NC_LOG_ALL_PROCS=1`で`GetProcAddress`の全取得名を記録し、`/proc/<pid>/maps`で`dsound.dll`/XAudio2が一切ロードされず`mmdevapi.dll`だけがロードされること、`CoCreateInstance`(これも`GetProcAddress`経由)で`CLSID_MMDeviceEnumerator`が作られることを確認した。`wasapi_hook.cpp`は`IAudioClient::GetMixFormat`のレートを1/Nにしてゲームへ見せ(88200Hz→44100Hz)、`Initialize`でN倍に戻して実ストリームを開く。ゲームは44100Hz相当の内容を書くが88200Hzで消費されるので、DirectSoundの`SetFrequency`スケールと同じ「テープの早回し」になる。同期マーカー(reports/88)は`IAudioRenderClient::ReleaseBuffer`でゲームの出力バッファへ直接足し込む。
- 全32bitタイトルのMODは`mods/common/build_mingw.sh <title>`(reports/88で追加)でビルドした。

## 3. 結果(2倍速、g6f.2xlarge、GPU描画+NVENC)

「落ち」は復元後(60fps)の落ちフレーム数(率)、括弧内は同じリプレイの等倍録画。全条件で**試行1回目で成功し、ScoreMonitorでリプレイの記録スコアと一致**した(th09は対戦のためスコア無し。th07/th08は終了直後にゴミ値が出るため記録値がログに現れることで確認)。

| タイトル / リプレイ | FpsMonitor 中央/下位5% | CPU(8vCPU) | 重複率 | 復元後の落ち(等倍) | 録画実時間(等倍) | マーカー比/残差 |
|---|---|---|---|---|---|---|
| th06 th6_02(Normal全6面) | 120.0/119.9 | 14.8% | 0.1% | 791=0.9%(631=0.7%) | 786s(1487s) | 479/+0.5ms |
| th06nc th6_01(Easy全6面) | 123.7/120.7 ※1 | 18.1% | 0.1% | 375=0.6%(140=0.2%) | 563s(1044s) | 850/+0.9ms |
| th07 th7_07(Extra) | 120.1/119.9 | 21.3% | 0.0% | 3=0.0%(2=0.0%) | 442s(836s) | 83/+0.3ms |
| th08 th8_01(Extra) ※2 | 120.1/119.9 | 20.8% | 0.3% | 47=0.1%(29=0.1%) | 410s(778s) | 122/+0.2ms |
| th09 th9_ud5615 | 359.7/358.7 ※3 | 11.8% | 0.0% | 0(0) | 84s(156s) | 96/-0.1ms |
| th10 th10_07(Hard 6面) | 119.8/119.6 | 12.7% | 0.0% | 3=0.0%(2=0.0%) | 202s(382s) | 137/-0.0ms |
| th11 th11_03(Hard全6面) | 119.9/119.5 | 12.4% | 0.0% | 493=0.6%(131=0.2%) | 801s(1513s) | 113/+0.3ms |
| th12 th12_02(Hard全6面) | 119.8/119.6 | 13.2% | 0.0% | 25=0.0%(40=0.0%) | 911s(1733s) | 106/+0.4ms |
| th128 th128_ud0000(Hard) | 119.8/119.6 | 16.7% | 0.0% | 12=0.0%(55=0.1%) | 449s(842s) | 44/+0.7ms |
| th15 th15_09(Extra) | 119.8/119.6 | 20.9% | 0.0% | 3=0.0% ※4 | 107s | 136/+0.1ms |
| th20 th20_01(Hard全6面) | 119.6/**109.7** | 28.4% | 0.0% | **1584=1.6%**(62=0.1%) | 901s(1668s) | 182/-1.0ms |

※1 th06ncのFpsMonitorは入力ポーリング回数でフレーム数と1対1ではない(等倍でも61.1Hz)。
※2 `--capture-window-id`(§5.3)で録画。
※3 th09は1フレームにつき3回ポーリングする(等倍で180Hz)。
※4 15〜165秒区間。等倍はreports/87の`extra_1x.mp4`で0枚。

- 録画実時間は等倍の**約52〜54%**。
- GPUはsm 5〜15%・enc 2〜9%で余裕がある。CPUも最大28%(th20)。
- **th20だけはFpsMonitorの下位5%が109.7Hzまで落ち、復元後の落ちも1.6%と等倍(0.1%)より明確に悪い**。th20はCPU描画時に16vCPUを要した最重量タイトル(docs/titles/th20.md)で、ゲーム本体の単一スレッド性能が2倍速に足りていない(reports/87のth15 3・4倍速と同じ律速)。
- th11(0.6% vs 0.2%)・th06nc(0.6% vs 0.2%)も等倍よりわずかに多いが、周期性は弱く(R≦0.37)、視聴上は小さい。

## 4. 結果(th06〜th08の3・4倍速)

| タイトル | 倍率 | FpsMonitor 中央/下位5% | CPU | 重複率(録画時) | 復元後の落ち | 録画実時間 |
|---|---|---|---|---|---|---|
| th06 | 3倍 | 180.0/179.0 | 20.0% | 4.5% | 2860=3.3% | 513s |
| th06 | 4倍 | 240.0/233.4 | 25.1% | 5.6% | 7865=8.9% | 391s |
| th07 | 3倍 | 180.0/179.8 | 25.5% | 0.2% | 589=1.2% | 290s |
| th07 | 4倍 | 240.0/239.8 | 30.1% | 12.2% | 3861=8.1% | 221s |
| th08 | 3倍 | 180.0/179.9 | 25.9% | 3.5% | 588=1.3% | 270s |
| th08 | 4倍 | 240.0/239.9 | 29.7% | 10.2% | 3084=7.0% | 204s |

- 全条件で試行1回目成功・記録スコア一致。**ゲーム本体は3倍速(180Hz)・4倍速(240Hz)でもほぼ完全に目標fpsを維持した**(th15と違い、th06〜08はゲーム側が律速にならない)。
- それでも復元後の落ちは3倍速で1.2〜3.3%、4倍速で7〜9%に増える。ゲームは240Hzで回っているのに録画側の重複率が10%を超えるので、**律速はx11grabのキャプチャ(1フレームずつ画面を読み出す処理)**であり、reports/87 §7で4倍速のth15に見られた「x11grabが240fpsを維持できない」のと同じ限界である。
- 3倍速はth07・th08で1.2〜1.3%と、2倍速(0.0〜0.1%)よりは悪いが実用の余地はある。th06はvpatchのフレーム制御と組み合わさるせいか3倍速でも3.3%と悪い。

## 5. 検証中に見つかり修正した問題(録画パイプライン)

### 5.1 1枚のvGPUで複数のXorgを立てると後から起動したものしか描画されない

タイトルごとに表示番号(`:87`、`:88`…)が違うため、th15の次にth06ncを録ると2つ目のXorgが立ち、先に起動していた方の画面のゲームがFpsMonitor 0Hzで固まった(VTを最後に取ったXorgしか描画が進まない)。`scripts/89_run_speedup_batch.sh`で、録画ごとに既存のGPU描画面をすべて止めてから始めるようにした。

### 5.2 GPU描画面では終了検知ポーリングが周期的なカクつきを起こす

th10の2倍速で復元後の落ち34枚・周期2.26秒(R=0.774)。reports/81の現象そのもので、`--gpu-display`指定時は`poll_side_stream`を自動で有効にする(`recorder/cli.py`)よう修正し、**落ち3枚・周期性なし**になった。B側の6タイトルはこの修正後に撮り直した(`*_ss`)。

### 5.3 th08はゲーム自身がウィンドウ位置を戻す → ウィンドウID基準の取り込み

th08(GPU描画面)は、録画開始前にクライアント領域を(0,0)へ移しても、その後ゲームがウィンドウを(Win32のタイトルバー分下がった)クライアント(3,29)へ設定し直すため、以後の映像がずれて終了画面のテンプレートが一致せず、終了検知できないまま録画が続いた(2倍速で1800秒超)。4倍速では(0,0)に戻しても0.5秒以内に繰り返し戻された。

試したこと:
1. openboxを「全ウィンドウ装飾なし・(0,0)固定」で起動 → **逆効果**。WineがWin32のタイトルバー領域を自前で確保し、クライアント領域がX窓の内側で(3,29)ずれる(xdotoolは(0,0)を返すので検知できない)。位置補正をしないth09で映像全体がずれて終了検知に失敗した。撤回。
2. 録画中に0.5秒ごとに位置を見張って(0,0)へ戻す(`recorder/window.py`の`start_origin_guard()`) → th08の4倍速では戻しても即座に戻される。
3. **x11grabの`-window_id`で取り込む**(`GameConfig.capture_by_window_id`、CLI`--capture-window-id`) → 位置に依存せず正しく録画でき、終了検知も正常。ただしゲームは起動直後にウィンドウを作り直すため、IDは録画開始直前に取り直す必要がある(検出時のIDでは`Can't find window`で起動失敗した)。

(2)の見張りは`capture_by_window_id`でないGPU描画面の録画で引き続き有効にしてある。

### 5.4 fps暴走検知の閾値が倍速で誤検知する

th09は1フレーム3回ポーリングするため2倍速で360Hzになり、タイトル別閾値(300Hz)で誤検知して打ち切られた。`recorder/modlog.py`に`speedup_runaway_threshold()`を追加し、タイトル別・既定の閾値とも倍率分引き上げるようにした(既定は環境変数`FPS_RUNAWAY_HZ_THRESHOLD`が無ければ100/倍率)。

### 5.5 thpracのアタッチが起動直後だと失敗する

th128(thprac必須)で`thprac --attach`が起動直後に対象を見つけられず終了し、thprac無しで再生が始まらずに3回とも失敗した。`recorder/process.py`の`attach_thprac()`を、マップへの反映を確認できるまで最大5回(1秒間隔)やり直すようにし、以後は2回目で成功するようになった。

## 6. 等倍録画とのタイムライン照合(`scripts/87_compare_timeline.py`)

等倍・倍速とも同期マーカー(reports/88)でmuxしたうえで、復元した2倍速を等倍と照合した。

| タイトル | video_offset(序盤→終盤) | av_delta(音声−映像のずれの差) |
|---|---|---|
| th07 | +4.167→+4.167s(一定) | +163〜+180ms(一定) |
| th08 | +2.05→+2.33s | +144〜+227ms |
| th09 | -0.37→-0.30s | +172〜+209ms |
| th10 | +0.28→+0.45s | +123→-33ms |
| th11 | +8.80→+8.93s | +109→-134ms |
| th06nc | +9.43→+9.68s | +30→-160ms |
| th06 | +6.6→+8.55s(ステージ遷移ごとに増加) | +101→+8ms |
| th128 | +0.60→+1.33s | -17→-390ms |

- 映像は、ゲームプレイ中はずれず、**ステージ間のロード等「実時間で進む区間」が復元で2倍に伸びる分だけ**後ろへずれていく(th06は全6面で+2秒)。reports/87 §4.2のth15 Hardと同じ性質で、ゲーム内容の欠落ではない。
- av_deltaが一定値(+0.15〜0.2秒)を持つタイトルがある。reports/88 §5の合成プローブでパイプライン自体のA/V誤差は±20ms以内と確認済みなので、これは**BGMの開始・ストリーミングがゲーム内部で実時間の遅れを含み、倍速ではそれが復元時にN倍に伸びる**ことによる「BGMとゲーム画面の対応」の差である(BGMは元々フレームと厳密には同期していない)。効果音はゲームのフレーム処理から直接鳴らされるので、この影響を受けない。
- av_deltaが時間とともに変わるタイトル(th06nc・th11・th128)は、ロード区間中もBGMが倍速で流れ続ける等のためと考えられるが、詳細は未調査。

## 7. 結論

- **2倍速録画は、GPU描画(g6f.2xlarge)でth06/th06nc/th07/th08/th09/th10/th11/th12/th128/th15の全タイトルで実用品質**。全タイトルとも試行1回目で成功・記録スコア一致・録画時間は等倍の約52〜54%、復元後の落ちフレームは等倍録画と同等(0.0〜0.9%)。
- **th20は2倍速ではゲーム本体が目標fpsを維持しきれず(下位5%で109.7Hz)、復元後の落ちが1.6%**(等倍0.1%)。実用には可能だが品質は他より明確に劣る。
- **th06〜08の3倍速は、ゲームは180Hzを完全に維持するが、x11grabのキャプチャ律速で復元後の落ちが1.2〜3.3%**。4倍速は7〜9%で実用的でない。
- 倍速化の手段はタイトルにより異なるが、共通部品(`speed_hack_hook`・`dsound_hook`・新規`wasapi_hook`・vpatchの`GameFPS`)の組み合わせで全タイトルをカバーできた。

## 未実施・残課題

- th20の2倍速の品質改善(より単一スレッド性能の高いインスタンスの検討)
- 3倍速以上でのキャプチャ律速の解消(x11grab以外のキャプチャ手段、例えばNVFBC等)
- 画面上のfps表示が倍率分の値になるタイトル(th06/th10等。低速録画時と同じ`fps_display_hook`での補正が必要)
- th06cは対象外(GPU描画・低速録画とも未検証)
- 本番(`recorder/`を使うsattori側)への組み込み: 倍速の既定化、`--capture-window-id`のth08既定化など

## 変更ファイル

- 新規: `mods/common/wasapi_hook.cpp/.h`、`scripts/89_setup_gpu_instance.sh`、`scripts/89_run_speedup_batch.sh`、`scripts/89_summarize_speedup.py`
- 変更(MOD): `mods/common/speed_hack_hook.cpp/.h`(timeGetTime/GetTickCount、GetProcAddress経由の差し替え)、`mods/common/dsound_hook.cpp/.h`(動的取得用の入口)、`mods/th06|07|08|09|10|11|12|128|20_replay_autoplay/dllmain.cpp`(speed_hack/dsound/FpsMonitorの組み込み)、`mods/th06nc_replay_autoplay/dllmain.cpp`・`build_mingw.sh`(WASAPI・QPC・CoCreateInstance)
- 変更(録画): `recorder/cli.py`(`--gpu-display`/`--crtc-mode`/`--capture-window-id`)、`recorder/config.py`(`capture_by_window_id`)、`recorder/ffmpeg.py`(`-window_id`)、`recorder/pipeline.py`・`recorder/window.py`(`start_origin_guard()`、ID取り直し)、`recorder/instance.py`(vpatch `GameFPS`)、`recorder/modlog.py`(閾値の倍率連動)、`recorder/process.py`(thpracリトライ)、`scripts/78_start_gpu_display.sh`(openbox設定の試行と撤回の記録)
- 検証データ(ローカルのみ): `/mnt/cache3/sattori-<title>-verify/phase89_speedup/{raw,restored}/`、全ログ`/mnt/cache3/sattori-speedup-phase89-logs/`、視聴ガイド`/mnt/cache3/sattori-speedup-phase89-README.md`
