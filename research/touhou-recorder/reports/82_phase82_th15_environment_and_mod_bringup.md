# フェーズ82: th15(東方紺珠伝)の環境構築・自動操作MOD実装

日付: 2026-09-16

## 背景

新規タイトルとしてth15(東方紺珠伝 ～ Legacy of Lunatic Kingdom.)の録画対応を開始する。ユーザーからth15はth20(錦上京)とほぼ共通のゲーム仕様(内部描画解像度960p相当、cfg/replayの配置場所が`%APPDATA%/ShanghaiAlice/<title>/`配下)であると事前情報が与えられており、`reports/44`〜`50`(th20)を先に確認した上で着手した。

作業開始前に`sattori-home-worker.service`が稼働中で直近のジョブ(th128)を処理していたことを確認したが、作業時点では既に`inactive (dead)`(2026-09-16 18:55:36 JST 停止)であり、`docker ps`・`ps aux`でも録画関連のwine/ゲームプロセスは実行されていなかった(放置されたXvfb残骸プロセス7個(:95〜:101、いずれもゲームプロセスなし、1日以上前から起動)を発見したが実害なしと判断しそのまま残置)。

## ゲーム資産の配置

`games/th15/`にユーザーが以下を配置済み:

- `th15.exe`(951808バイト)・`th15.dat`・`thbgm.dat` — ver1.00b(ユーザー確認済み、タイトルバー表示でも`ver 1.00b`を確認)
- `th15.cfg` — 960pウィンドウモード用設定(`%APPDATA%`配下に配置する前提)
- `vpatch.exe`/`vpatch.ini`/`vpatch_th15.dll`/`vpatch_readme_th15.txt`、`thprac.v2.3.1.1.exe` — 未使用(通常動作を優先、必要時のみ使用)
- `replay/th15_01.rpy`〜`th15_09.rpy` — ユーザー提供の検証用リプレイ9本

`../sattori/packages/replay-parser`のCLI(`node ../sattori/packages/replay-parser/dist/cli/index.js -j <file>`)で全リプレイのメタデータを取得した結果:

| ファイル | 難易度 | ステージ | cleared | frameCount | 用途 |
|---|---|---|---|---|---|
| th15_07.rpy | Hard | Stage All Clear | true | 各ステージ合計(最終フレーム記載省略、全6ステージ) | **通常ステージのフル尺録画候補** |
| th15_08.rpy | Extra | Extra Stage | false | 45872(≒12.7分) | **Extraステージのフル尺録画候補(最長)** |
| th15_09.rpy | Extra | Extra Stage | false | 9215(≒2.6分) | 短尺動作確認用(本フェーズで使用) |

th15_08/09は未クリアだがフル尺録画の要件(尺の最初から最後まで録画)には未クリアでも問題ないため、th15_07(通常/Hard)とth15_08(Extra)を次フェーズ以降のフル尺録画対象とする。全クリアのExtraリプレイが必要になった場合はSilentSeleneからの追加取得を検討する。

## WINEPREFIX構築

`prefixes/th20-wined3d-gl`(MSゴシック/MS明朝導入済み)を`cp -a`で複製して`prefixes/th15-wined3d-gl`を作成した(reflink/CoWにより1秒未満で完了)。複製後、複製元由来の`drive_c/users/hakatashi/AppData/Roaming/ShanghaiAlice/th20/`ディレクトリを削除し、`.../ShanghaiAlice/th15/`を新規作成して`games/th15/th15.cfg`を配置した。

## 起動確認

`instances/th15-manual-test/`に`games/th15/`を複製し、Xvfb(`:199`、`1400x1100x24`)+openbox上で`wine th15.exe`を直接起動したところ、追加設定なしで**1280×960のウィンドウモードで安定起動**した(`xwininfo`でウィンドウサイズ`1280x960+1+20`を確認、タイトルバーに`ver 1.00b`表記)。フルスクリーンでのXvfbハングは発生せず、ユーザー提供のcfgが正しくウィンドウモードを指定していることを確認した。

タイトル画面のスクリーンショットで、メニュー項目が`Game Start / Extra Start(グレーアウト) / Practice / Replay / Player Data / Music Room / ...`の構成であることを確認し、ユーザー提供の操作手順(Down×2でExtra Startをスキップして「Replay」に到達)と一致することを確認した。

## MOD実装(`mods/th15_replay_autoplay/`)

th20のMOD(`mods/th20_replay_autoplay/dllmain.cpp`)をベースに新規作成した。`build.bat`(MSVC用、th20と同様の構成からscore_monitor/stage_marker_hook/fps_display_hookを除外)と、mingw-w64クロスビルドコマンドは以下の通り:

```bash
cd mods/th15_replay_autoplay
i686-w64-mingw32-g++ -shared -O2 -o build/th15_hook.dll \
    dllmain.cpp \
    ../common/dinput_hook.cpp ../common/window_wait.cpp ../common/logging.cpp \
    ../common/fps_monitor.cpp ../common/fps_limiter_hook.cpp ../common/dsound_hook.cpp \
    ../common/stage_probe_hook.cpp ../common/stage_marker_io.cpp \
    -static-libgcc -static-libstdc++ -static -luser32
```

### 発見: th15はGetKeyboardStateではなくGetDeviceState(DirectInput)でポーリングする

AGENTS.mdには「th11以降(TH10以降のエンジン)はGetKeyboardStateでポーリングする」という既知の知見があったため、th20のMODをそのまま踏襲し`PressVKey`(GetKeyboardState方式)でDown×2→Enter→Right→Enter→Enterを実装した。

実機検証の結果、この方式では**メニュー操作が一切反映されず**、`AutoPlayThread`の`sequence complete`ログは正常に出力されるにもかかわらず、実際の画面は無操作のままアトラクトデモ(画面中央に「Demo Play」の文字、難易度表示が常に「NORMAL」固定)に遷移してしまうことを確認した。診断のため、Step2(Replay確定)〜Step5(再生確定)の各ステップ間に`TH15_DEBUG_PAUSE`環境変数で5秒の待機を挿入し、各ステップ後にスクリーンショットで画面遷移を確認する手法を用いた。

`PressVKey`を`PressKey`(DIKコード: `DIK_DOWN=0xD0`, `DIK_RIGHT=0xCD`, `DIK_RETURN=0x1C`、th06/07/08/10と同じGetDeviceState方式)に切り替えたところ、Step2直後に正しく「REPLAY」画面(リプレイ選択リスト、ユーザーリプレイが既に一覧表示)に遷移し、Step3(Right)〜Step5完了後に実際にExtraステージのリプレイ(画面右上に「EXTRA」表示、スコア増加を確認)が再生されることを確認した。

**th15はth14系の960pエンジンだが、入力ポーリング方式はth11/th20(GetKeyboardState)ではなくth06/07/08/10と同じGetDeviceStateである**。「TH10以降のエンジンはGetKeyboardState」という既存知見はth15には当てはまらないため、他の未検証タイトルに移植する際もこの前提を鵜呑みにせず実機確認が必要。

### 実装したメニュー操作シーケンス

```
Buffering 10000ms(scaled) → Down×2(250ms間隔) → Enter → Right → Enter → Enter
```

`ArmStageMarkerIo()`はth20と同様、Right押下後(Step3〜Step4間)に呼び出し、起動時アセットロードとの誤検出を避けている。

### 短尺リプレイ(th15_09.rpy、Extra、frameCount=9215≒2.6分)での通し確認

- `th15_ud0000.rpy`として配置(命名規則はth20と同一の`<game>_ud0000.rpy`)
- injector経由でMOD注入・自動操作・リプレイ再生・終了まで通しで確認
- FPSは`FpsMonitor`ログで57〜60Hz(起動直後のみ57Hz、以降60.0Hz安定)
- 再生終了後、ユーザー指定の座標(左上を(0,0)として(81,350)から幅389px高さ450px)は「再生終了/ゲームを終了/もう一度再生する」のメニューテキスト全体をほぼカバーしており、`still_detect_exclude_rect`として妥当と判断した(スクリーンショットで目視確認、画面中央の魔法陣演出・スコアアニメーション等はこの矩形の外)

## スコア・残機・グレイズのRVA特定(score_monitor統合)

`../thprac/thprac/src/thprac/thprac_th15.cpp`の`th15_patch_main`フック(プラクティスモード開始時の初期値書き込み処理、L1950〜)で、以下の絶対アドレスへの書き込みを確認した:

```cpp
*(int32_t*)(0x4E740C) = (int32_t)(thPracParam.score / 10);  // スコア(内部値、表示は×10)
*(int32_t*)(0x4E7450) = thPracParam.life;                     // 残機
*(int32_t*)(0x4E741C) = thPracParam.graze;                    // グレイズ(0x4E7420はチャプター単位グレイズ)
```

th15.exeのPEヘッダ(ImageBase)を確認したところ`0x400000`(標準)だったため、RVAは`baseRva=0xE7400`(=`0x4E7400-0x400000`)を基点に、`scoreOffset=0x0C`・`livesOffset=0x50`・`grazeOffset=0x1C`とした(`mods/common/score_monitor.h`の`ScoreMonitorConfig`、`baseIsPointer=false`)。th20の`GlobalsSide`構造体のようなポインタ間接参照は不要で、モジュール直下の静的領域に直接配置されている点がth15の特徴。ステージ番号を保持する単純な変数は`thprac_th15.cpp`全体(2065行)を確認した範囲では見つからなかった(`CalcSection()`による区間IDの動的計算のみ)ため、`stageWidth=0`のまま無効にしている。

## `scripts/25`統合・短尺動作確認

`GAME_CONFIGS["th15"]`をth20エントリの直後に追加した(`display=":87"`, `wineprefix=prefixes/th15-wined3d-gl`, `xvfb_screen="1400x1100x24"`, `appdata_dir`はth20と同じ`ShanghaiAlice/th15`パターン, `replay_dest_filename="th15_ud0000.rpy"`, `still_detect_exclude_rect=[(81,350,470,800)]`)。th15_09.rpy(短尺Extra)・`--record-seconds 40`での動作確認で重複フレーム率2.0%、`StageMarker: stage_load`ログ(アセットロードバースト検出)も正常に出力されることを確認した。ステージ番号変数を使わないタイトルのchapters出力ロジック(`scripts/25`側)はタイトル名で分岐しておらずログのパターンマッチのみで動作するため、th15固有の追加実装は不要だった。

## フル尺録画(通常Hard、th15_07.rpy)

### インシデント: ルートファイルシステムのディスク枯渇でBash/Writeツールが機能不全に

`runs/th15_verification/`(ルートファイルシステム上)に出力する形で初回のフル尺録画(約34分、1本あたり4〜5GB)を実行したところ、録画中盤(31分38秒経過時点)でホストのルートファイルシステムが枯渇し、ffmpegが`No space left on device`で異常終了した。この際、Claude Codeのセッション用一時ファイル領域(`/tmp/claude-1000/.../tasks`)も同じルートファイルシステム上にあったため空き0MBとなり、**Bashツール・Writeツールが完全に機能不全**(`echo test`のような最小コマンドすら`ENOSPC`で失敗)になる実インシデントが発生した。ユーザーに不要ファイルの削除を依頼し復旧した。

**恒久対応としてユーザー指示により、録画検証の出力先を`/mnt/cache3/sattori-<title>-verify/`(別ボリューム、3.6TB・空き3.2TB)に変更**した(AGENTS.md更新、既存の`sattori-th06c-verify`等と同じ命名パターン)。このマシンのルートファイルシステムは常時使用率98%前後で逼迫しているため、今後もフル尺録画等の大容量出力は`runs/`ではなく`/mnt/cache3`配下に置くこと。

### インシデント: sattori-home-worker停止後もPulseAudio専用シンクが残置されauto_nullが復活しない

出力先変更後の1回目の試行では、録画・ゲームプレイ・ステージ検出は最後まで正常に完走した(chapters: 1面00:13/2面04:15/3面08:49/4面14:00/5面19:24/6面27:06)にもかかわらず、**音声ファイルが生成されず**mux処理が失敗し、`scripts/25`が「試行失敗」と判定して最初から再試行する事態になった(結果的に34分の録画が2回無駄になった)。

原因は、直前まで動いていた`sattori-home-worker`(th128ジョブ)が作成した専用null-sink(`sattori_job_local_*`、AGENTS.mdの音声キャプチャ節に記載の「専用シンクを1つでも追加すると既存のauto_nullは自動的にunloadされる」仕様)が、サービス停止後も**unloadされずに残置**されていたこと。`scripts/25`は録音先を固定で`auto_null.monitor`と指定しているため、存在しないデバイスに対し`ffmpeg`が`Input/output error`で即座に終了し、ゲーム自体の音声出力(`pactl list sink-inputs`で確認)は偶然生き残っていた残置シンクの1つに流れてしまっていた。

`pactl unload-module <残置シンクのモジュールID>`で全ての`sattori_job_local_*`をunloadし`auto_null`を復活させることで解消した。試行3(最終試行)で正常な録画(音声トラックあり)が得られた。**他タイトルの録画作業を開始する前は、`pactl list short sinks`で`auto_null`の存在を必ず確認すること**(sattori-home-worker停止直後でも安心せず、残置シンクの有無をチェックする)。

### 結果

- 総録画時間2067.7秒、`th15_hard_fulllength.mp4`(1280x960, h264+aac, duration=2060.6秒, 約5.0GB)
- A/V同期補正: `delta=-0.029s`(良好)
- ステージ検出(全6ステージ): 00:13 / 04:13 / 08:47 / 13:58 / 19:22 / 27:04
- 重複フレーム率: 録画開始15秒後30秒間のサンプルで1.3%(ローカル単一インスタンス実行のため良好)
- **理論尺比較**: リプレイの`frameCount`合計120816フレーム(@60fps=2013.6秒) vs 実測プレイ時間(総録画時間2067.7秒 − メニュー操作14秒 − 静止検知待機16秒 = 2037.7秒) で **超過+1.2%**(良好、AWS実機検証時の判断材料として記録)
- **スコア完全一致**: `score_monitor`が記録した最終内部値`41720113` × 10 = `417201130` = リプレイファイルの記録スコアと完全一致。倍率×10(th07/th08/th11/th20と同じ分類)を確認

## フル尺録画(Extra、th15_08.rpy)

出力先変更・PulseAudio対応後は試行1回目で正常な録画が得られた(総録画時間841.5秒、`th15_extra_fulllength.mp4`、1280x960 h264+aac、duration=838.7秒)。

- ステージ検出: `00:00 動画開始` / `00:13 1面`(Extraステージは1面のみ)
- 重複フレーム率: 録画開始15秒後30秒間のサンプルで1.6%
- **スコア完全一致**: `score_monitor`最終内部値`11034790` × 10 = `110347900` = リプレイファイルの記録スコア(th15_08.rpyは未クリア、`lives=-1`でゲームオーバー終了を確認)
- **理論尺比較**: `frameCount`45872フレーム(@60fps=764.5秒) vs 実測プレイ時間(総録画時間841.5秒 − メニュー操作14秒 − 静止検知待機16秒 = 811.5秒)で**超過+6.1%**。Hard(通常ステージ、+1.2%)と比べて明確に大きく、Extraステージでの処理落ちを示唆する数値だった

## 処理落ちの発見(ユーザー指摘、th20と同種)

ユーザーがダウンロードした`th15_hard_fulllength.mp4`を視聴した結果、「12:52〜のシーンなどエフェクトが激しい場面でfpsが半分程度に落ち込んでいる(th20と同じタイプの処理落ち)」との指摘を受けた。

`scripts/81_analyze_stutter_periodicity.py`でHard動画の700〜1000秒区間を解析したところ、13:46〜13:54(826〜834秒)にかけて連続的なフレーム脱落(2〜10フレーム単位の脱落が断続、合計約30フレーム相当)を検出したが、位相集中度R=0.274で「目立った周期性は無い」という自動判定だった。Extra動画では、752〜768秒(12:32〜12:48)にかけてさらに顕著な連続脱落(1回あたり15〜29フレーム=250〜483ms相当)が複数回検出された。

ユーザーの追加提案(「描画側の処理が追いついていないのが原因と思われるので、動画のfpsカウンタを目視確認することでも検証できる」)に従い、Extra動画の753秒地点のフレームを`ffmpeg -ss 753 -frames:v 1 -update 1`で抽出したところ、**画面右下に「30.9fps」の表示**を確認した(強力な閃光エフェクトを伴うボス攻撃演出の最中)。ゲーム内蔵のfpsカウンタが実測でネイティブの約半分まで低下していることを直接視認でき、th20と同様に「激しいエフェクトで描画処理が追いつかず、Presentが間引かれる」タイプの処理落ちであることを確定した。`scripts/81`の周期性分析だけでは(散発的で低R値のため)重大度を過小評価しかねないので、大きめの連続脱落区間は必ずフレーム抽出でfps表示を目視確認することが有効だと再確認できた。

## 低速録画機能の検証、および全タイトル共通バグの発見・修正

`mods/th15_replay_autoplay/dllmain.cpp`は新規実装時点で`InstallFpsLimiterHook`・`InstallDSoundHook`・`ScaledSleep`(メニュー操作待機のタイムスケール)をth20から踏襲済みだったため、追加のMOD実装は不要だった。`FPS_LIMIT_TARGET_HZ=30`環境変数を指定して短尺リプレイ(th15_09.rpy)で動作確認したところ、以下は正常に機能した:

- `FpsMonitor`ログが29.9〜30.0Hzで安定
- メニュー操作の`Buffering`(本来10000ms)が実測約20秒(scale=2.0)、Down×2〜Enter×3のシーケンス全体も本来の約2倍の時間で完了

### 発見: 低速録画の最終判定(`--max-duplicate-rate`)がスケーリング未対応だった(全タイトル共通のバグ)

しかし`scripts/25`は録画完了後、「録画開始15秒以降30秒間の重複フレーム率」が実測58.3%(30fps録画では意図的な重複が理論上50%発生するため正常な値)であるにもかかわらず、固定閾値`--max-duplicate-rate`の既定値30.0%を超過したと判定し、3回とも「処理落ちの疑い」でリトライ→失敗する不具合が発生した。

フェーズ69(th09)で対応した`STUTTER_DUP_FRACTION_THRESHOLD`(早期処理落ち検知`probe_stutter`用の閾値)は`MENU_TIME_SCALE`に応じて動的にスケールする実装だったが、**録画完了後の最終判定に使う`--max-duplicate-rate`引数のデフォルト値には同じスケーリングが適用されていなかった**(見落とされていた別経路のバグ、th06/07/08/10/12/20の低速録画運用でも理論上同じ条件で起こりうる)。

`scripts/25_record_replay_e2e_multigame.py`の`--max-duplicate-rate`のデフォルト値を、`STUTTER_DUP_FRACTION_THRESHOLD`と同じ考え方(ネイティブ60fps時のマージン比率を維持)で`MENU_TIME_SCALE`に応じてスケールするよう修正した:

```python
default=100.0 - (100.0 - 30.0) / MENU_TIME_SCALE if MENU_TIME_SCALE > 0 else 30.0
```

`MENU_TIME_SCALE=1.0`(ネイティブ60fps)では従来通り30.0%、`MENU_TIME_SCALE=2.0`(30fps低速録画)では65.0%になる。修正後、th15_09.rpyでの低速録画テストが正常完了(重複フレーム率58.1%、新閾値65%以下で正常判定)することを確認した。

### 低速録画でExtraステージ全体を録画し、処理落ち解消を確認

短尺リプレイ(th15_09)には激しい弾幕区間が含まれていなかったため、実際に処理落ちが確認された`th15_08.rpy`(Extra)全体を`FPS_LIMIT_TARGET_HZ=30`で録画した(`th15_extra_slowmo.mp4`、総録画時間1594.0秒)。

- **理論尺比較**: `frameCount`45872フレーム(@60fps=764.5秒)の低速録画時理論値は764.5×2=1529.0秒。実測プレイ時間(総録画時間1594.0秒 − メニュー操作27.8秒 − 静止検知待機16秒 ≈ 1550.2秒)との差は**+1.4%**。通常速度録画での同ステージの超過(+6.1%)から大幅に改善した
- **fps表示の目視確認**: 通常速度で30.9fpsまで低下していたのと同じスペルカード演出(「月「ルナティックインパクト」」、通常録画752秒地点に相当する低速録画側の1504秒地点)のフレームを抽出したところ、**画面右下に安定した「30.0fps」表示**を確認した。通常速度で処理が追いつかず半減していた激しいシーンでも、30fps基準ではCPU/描画処理が確実に間に合っていることを直接視認できた

以上より、**低速録画(`FPS_LIMIT_TARGET_HZ=30`)はth15のExtraステージの処理落ちを実質的に解消する**ことを確認した(th20と同じ結論)。

副次的な発見として、Extraステージ(本来1ステージのみ)のchapters出力で`00:13 1面`の1秒後に`00:14 2面`が誤検出された(`stage_marker_io`のアセットロードバースト検出が、低速録画特有のI/Oタイミングにより1回の読み込みを2回のバーストと誤認した可能性)。録画結果自体には影響しないが、低速録画時のchapters出力の信頼性には注意が必要。

## AWSクラウド実機検証

`cloud/docker/aws/Dockerfile.th15`を新規作成(`Dockerfile.th20`を踏襲、th15単体の軽量イメージ)。ビルド時に`.dockerignore`が`games/th15/`を明示的に除外していた(未対応タイトルだった頃の名残)ため、該当行を削除して再ビルドした。イメージサイズ約2.4GB、ECR(`<AWS_ACCOUNT_ID>.dkr.ecr.eu-south-2.amazonaws.com/touhou-recorder-th15:test`)にpush済み。

### スポット価格調査(2026-09-16、eu-south-2)

| インスタンス | AZ | スポット価格/h |
|---|---|---|
| c7i.4xlarge(th20推奨帯) | a | $0.184 |
| c7i.4xlarge | b | $0.122 |
| c7i.4xlarge | c | $0.116 |
| g6f.xlarge(GPU) | a | $0.049 |
| g6f.xlarge | b | $0.064 |
| g6f.xlarge | c | $0.267(高いため避ける) |
| g6f.2xlarge(GPU) | a | $0.067 |
| g6f.2xlarge | b | $0.078 |
| g6f.2xlarge | c | $0.168(高いため避ける) |

ユーザー指摘により、**GPU付きインスタンス(g6f系、AZ a/b)がCPUのみのth20推奨帯(c7i.4xlarge)より明確に安い**ことが判明(全て0.2USD/hour以下)。GPU描画(th06ncと同じDXVK経由)で処理落ちが解消するか追加検証する方針とした。

### CPUインスタンス(c7i.4xlarge)での実機検証

`touhou-recorder-th15-key`(新規作成)・既存の`touhou-recorder-verify-sg`(`<SECURITY_GROUP_ID>`)・`<SUBNET_ID>`(eu-south-2b)・AMI`<AMI_ID>`(Amazon Linux 2023、th09/th10/th12と共通)でスポットインスタンス(`<INSTANCE_ID>`)を起動した。ECS最適化AMIではないため`systemctl disable --now ecs`は不要、Dockerは`dnf install -y docker`で導入した。

短時間動作確認(`RECORD_SECONDS=40`、th15_09.rpy)は追加設定なしで正常動作(exit_code=0、S3アップロード成功、`OUTPUT_BUCKET`はus-east-1の既存バケット`touhou-recorder-output-<AWS_ACCOUNT_ID>`をリージョンをまたいで流用、th09/th10と同じ運用)。

### CPUインスタンス(c7i.4xlarge)でも処理落ちは解消しない(訂正あり)

Hard(通常ステージ、th15_07.rpy)・Extra(th15_08.rpy)それぞれのフル尺録画をc7i.4xlargeで実行し、いずれも試行1回目でexit_code=0・正常完了した。

| | Hard(ローカル) | Hard(c7i.4xlarge) | Extra(ローカル) | Extra(c7i.4xlarge) |
|---|---|---|---|---|
| 総録画時間 | 2067.7秒 | 2063.0秒 | 841.5秒 | 834.4秒 |
| 重複フレーム率(15秒後30秒間) | 1.3% | 1.8% | 1.6% | 1.2% |
| 理論尺超過 | +1.2% | +0.96% | +6.1% | +5.2% |

理論尺超過はHard/Extraともローカルとクラウドでほぼ同水準だった。これはExtra(未クリアで終わるリプレイ)がHard(全クリア)と比べて系統的に理論尺超過が大きいこと(ゲームオーバー後の追加シーンがリプレイの`frameCount`に含まれないためと考えられる)を示しており、**未クリアリプレイでの理論尺比較は処理落ち検出の指標として使えない**。

**【訂正】当初、Extraステージの752秒地点1点のみをフレーム抽出して比較し「ローカル30.9fps → c7i.4xlarge 59.9fps、処理落ち解消」と結論したが誤りだった**。ユーザーから「処理落ちで尺が伸縮するため、絶対時間でのスクリーンショット比較は同じ場面を見ていない可能性がある」との指摘を受け、同じスペルカード演出(Hecatia Lapislazuliの弾幕)区間を3秒間隔でlocal/cloudの両方サンプリングし直したところ、以下の通りいずれも激しく変動しており、**単発のサンプルでは判断できない**ことが分かった:

| 経過時刻(録画開始からの絶対秒) | 745s | 748s | 751s | 754s | 757s | 760s | 763s | 766s | 平均 |
|---|---|---|---|---|---|---|---|---|---|
| ローカル | 60.0 | 60.0 | 57.7 | **17.9** | 22.7 | 60.0 | 20.8 | 49.7 | 43.6 |
| c7i.4xlarge | 52.8 | **15.2** | 37.9 | 59.3 | 21.0 | 56.6 | 50.0 | 60.0 | 44.1 |

平均・最低値(ローカル17.9fps、c7i.4xlarge15.2fps)ともほぼ同水準で、**c7i.4xlarge(16vCPU)へのスペックアップでは処理落ちは改善しなかった**。当初59.9fpsを観測した752秒は、たまたま両者とも処理落ちの合間だったに過ぎない。処理落ちの原因はCPUコア数ではなく、単一スレッドの処理速度(wined3dのDirect3D9→OpenGL変換や、ゲーム本体のロジック処理)がボトルネックになっている可能性が高い。**fps表示の目視確認を行う際は、単発のサンプルではなく複数地点(できれば同一演出区間を数秒間隔で)を必ずサンプリングすること**を教訓として記録する。低速録画(`FPS_LIMIT_TARGET_HZ=30`)がこの処理落ちを解消できたのも、CPUリソースを追加するのではなく目標フレームレート自体を下げて1フレームあたりの処理時間の余裕を作ったためだと考えられ、この仮説と整合する。

### GPUインスタンス(g6f.2xlarge)でのDXVK導入とVulkan機能不足

`touhou-recorder-th15-key`・既存の`touhou-recorder-verify-sg`で、DLAMI(`<AMI_ID>`、Deep Learning Base OSS Nvidia Driver GPU AMI Ubuntu 24.04)からg6f系インスタンスを起動しようとしたところ、**g6f.xlargeはAZ a/bとも`InsufficientInstanceCapacity`で起動できず**、g6f.2xlarge(AZ b、`<INSTANCE_ID>`)でようやく確保できた。

GRIDドライバ導入(`reports/81`の手順、`NVIDIA-Linux-x86_64-595.91.07-grid-aws.run --silent --dkms --compat32-libdir=/usr/lib/i386-linux-gnu`)自体は成功し、`nvidia-smi`で`NVIDIA L4-6Q`(g6f.2xlargeの8vCPU/6GiBスライス)を認識、`scripts/78_start_gpu_display.sh --backend xorg`でXorg+nvidiaのヘッドレスX画面(`glxinfo`で`OpenGL renderer: NVIDIA L4-6Q`を確認)も構築できた。

**発見1: `nvidia-xconfig --query-gpu-info`がこのドライババージョン(595.91.07)では`ERROR: Unable to query GPU information`で失敗する**(`reports/81`のth06nc検証時は成功していた)。`scripts/78_start_gpu_display.sh`に、`nvidia-smi --query-gpu=pci.bus_id`(16進、例`00000000:31:00.0`)からXorg形式のBusID(10進、`PCI:49:0:0`)を算出するフォールバックを追加して解消した。

**発見2: `--compat32-libdir=/usr/lib/i386-linux-gnu`と指定すると、インストーラが内部でパスを`/usr`と結合してしまい`/usr/usr/lib/i386-linux-gnu/`に32bitライブラリを誤配置する**(NVIDIAインストーラの既知の癖の可能性)。`cp -a /usr/usr/lib/i386-linux-gnu/* /usr/lib/i386-linux-gnu/ && ldconfig`で正しい場所に複製することで回避した。

**発見3(未解決): DXVK v3.1.1がGRIDドライバのVulkan実装を拒否する**。`vulkaninfo`(64bit)では`NVIDIA L4-6Q`が`apiVersion=1.4.329`・`conformanceVersion=1.4.3.3`を正しく報告しているにもかかわらず、DXVK(32bit、th15はD3D9アプリ)は`Skipping: Device does not support required feature 'khrLoadStoreOpNone' (extension: VK_KHR_load_store_op_none)`でNVIDIAデバイスを除外し、`No adapters found`で起動失敗する。`VK_KHR_load_store_op_none`はVulkan 1.3のコア機能に含まれるはずだが、vGPU(GRIDドライバ)のプロファイルでは機能フラグが無効化されている可能性がある。32bit版`vulkan-tools`パッケージが存在せず32bit側から直接`vulkaninfo`で機能を確認する手段が無かったため、原因の完全な特定には至っていない。

DXVKを断念し、wined3d(OpenGL)経由でのGPU利用に切り替えた。`glxinfo`で`OpenGL renderer: NVIDIA L4-6Q`を確認済み。`scripts/25`をGPU画面(`gpu_display: True`)で動かす際、th15のウィンドウが期待の1280x960ではなく1030x748に縮小される問題が発生し、原因はXorgの**CRTCモードが既定の1024x768のまま**だったこと(th06ncの1080p検証時と同じ既知の症状、`reports/81`)と判明、`--crtc-mode 1280x960`の明示指定で解消した(1280x940で起動、`openbox`の再起動も必要)。Extraステージのフル尺録画によるGPU効果の実測は、次のインシデントにより中断した。

### 【重要インシデント】eu-south-2 GPUインスタンスが本番環境のG系クォータに影響

g6f.2xlarge(8vCPU)を起動した状態で作業を続けていたところ、**eu-south-2リージョンのG系インスタンスCPUクォータ(8vCPU、フェーズ81でユーザーが緩和申請した枠)を使い切ってしまい、sattori本番環境(eu-south-2でG系インスタンスを使う既存ジョブ)に影響が生じた**。ユーザーからの緊急連絡を受け、該当インスタンス(`<INSTANCE_ID>`)を即座にterminateして解消した(CPUインスタンス`<INSTANCE_ID>`はG系クォータと無関係のため継続使用の了承を得た)。

**教訓**: eu-south-2のG系(g6f等)インスタンスクォータは本番環境と共有される限られた資源(8vCPU)であるため、**検証用にG系インスタンスを起動する際は、本番ジョブが同時にG系インスタンスを必要とする可能性を考慮し、長時間の占有を避けるか、事前にユーザーに確認すること**。GPU検証は`us-west-2`(th06nc検証で実績のあるリージョン、別クォータ枠)に切り替えて続行する。GPU環境構築の再現手順(AMI選定・GRIDドライバ導入・32bitライブラリ誤配置の回避・CRTCモード指定)は上記の通り確立済みのため、リージョンを変えても大幅な手戻りにはならない見込み。

### us-west-2での再構築、および発見4: GRIDドライバのバージョンはリージョン/ホストごとに互換性が異なる

us-west-2でg6f.xlargeは全AZで`InsufficientInstanceCapacity`により起動できず、g6f.2xlarge(AZ a、`<INSTANCE_ID>`)で確保した(1回目の試行`<INSTANCE_ID>`はg6f.xlarge AZ bで一旦起動したが、直後に`instance-terminated-by-service`でAWS都合により強制終了された)。

**発見4: eu-south-2で動いた最新のGRIDドライバ(595.91.07、`latest/`)が、us-west-2のこのインスタンスでは`nvidia-smi`が`No devices were found`を返し使えなかった**。`dmesg`で`NVRM: Xid (PCI:0000:31:00): 78, Guest driver is incompatible with host driver`というエラーを確認し、ゲスト側ドライバとホスト(ハイパーバイザー)側のGRIDマネージャーとのバージョン不整合と判明した。一つ前のメジャーバージョン(595.71.05、`grid-20.1/`)でも同じエラーが再現したが、**さらに1世代前(580.178.04、`grid-19.6/`)まで下げたところ正常動作した**(`nvidia-smi`で`NVIDIA L4-6Q`を確認)。**GRIDドライバは`s3://ec2-linux-nvidia-drivers/`直下に`latest/`の他`grid-19.x/`・`grid-20.x/`等のバージョン別ディレクトリがあり、`latest`が特定のリージョン/ホストで動かない場合は1〜2世代前を順に試す価値がある**。インストール済みのDKMSモジュールを入れ替える際は`rmmod nvidia_drm nvidia_modeset nvidia_uvm nvidia`(依存順)でアンロードしてから新バージョンのインストーラを実行する必要があり、`nv-hostengine`(DCGM)等が`/dev/nvidia*`を掴んでいるとrmmodが失敗するため`pkill -9 nv-hostengine`で先に止める。

ドライバ問題解決後は、eu-south-2で確立した手順(32bitライブラリ誤配置の複製・`--crtc-mode 1280x960`込みでのXorg起動)をそのまま適用でき、短尺リプレイでの動作確認(ウィンドウサイズ1280x940、重複フレーム率0.0%)まで一度で完了した。

### 発見5: GPU描画面(Xorg+nvidia)で、録画開始直前にウィンドウが再配置される

Extraステージの1回目のフル尺録画で、`ensure_ready`完了時点(ウィンドウ検出直後)の`xdotool windowmove 0 0`は成功していたが、**その後`WaitForStableWindow: stable`検出までの間にウィンドウが元の位置(openboxの初期配置座標、`(289, 315)`)へ勝手に戻ってしまう**現象を発見した(Xvfb環境では未確認、GPU/Xorg環境固有の可能性)。この結果、録画コマンド(`-i :88+0,0`)は画面左上の黒い領域しか捉えられず、ウィンドウ本体・fps表示が録画からほぼ欠落した状態でキャプチャされていた(理論尺比較の数値自体はダメージを受けていなかったため、処理落ち検証の結論には影響しなかった)。

`scripts/25_record_replay_e2e_multigame.py`に、`gpu_display`指定時のみ「録画開始直前(`WaitForStableWindow: stable`検出後)に座標を再確認し、ずれていれば再度`windowmove`する」防御的な処理を追加して解消した(`skip_origin_move_if_fits`指定タイトルは対象外)。原因(なぜGPU/Xorg環境でだけウィンドウが再配置されるか)は未特定。

### 【結論】GPU利用(wined3d+OpenGL経由)でExtraステージの処理落ちは完全に解消する

修正後、Extraステージのフル尺録画を再実行した(総録画時間801.5秒、重複フレーム率0.3%)。

- **理論尺比較**: `frameCount`45872フレーム(@60fps=764.5秒) vs 実測プレイ時間(801.5秒 − メニュー操作14.2秒 − 静止検知待機16秒 = 771.3秒)で**超過+0.89%**(ローカル/c7i.4xlargeの+5.2〜6.1%から大幅改善)
- **fps表示の目視確認**: 同一スペルカード演出(「月「ルナティックインパクト」」)区間を、ローカル/c7i.4xlargeでの比較と同じ8地点(745, 748, 751, 754, 757, 760, 763, 766秒)でサンプリングしたところ、**全地点で59.9〜60.0fps**(ローカル平均43.6fps・最低17.9fps、c7i.4xlarge平均44.1fps・最低15.2fpsと比べ圧倒的に良好)

**th15のExtraステージの処理落ちは、CPUコア数の追加では解消しないがGPU(wined3d+OpenGL、g6f.2xlarge)を使えば完全に解消する**ことを実測で確定した。低速録画(`FPS_LIMIT_TARGET_HZ=30`)も処理落ち解消の代替手段として機能する(フェーズ82の別項目で確認済み)ため、本番運用ではGPUインスタンス(コストもCPU上位帯より安い)を優先し、GPU利用が難しい場合のフォールバックとして低速録画を使う、という二段構えの方針を推奨する。

## 未実施(次フェーズへ)

- `STAGE_PROBE=1`でのステージ開始検出方式の追加検証(現状`stage_marker_io`方式で実用上問題なく動作しているため優先度は低い)
- 低速録画時のchapters誤検出(Extraステージで2ステージ検出された件)の原因調査
- GPU描画面でウィンドウが録画開始直前に再配置される現象(発見5)の根本原因調査(現状は防御的な再移動処理で回避済み、他のGPU利用タイトル(th06nc)でも起こりうるか要確認)
- DXVK機能不足(`VK_KHR_load_store_op_none`未サポート)の根本原因調査は優先度を下げる(wined3d経由で代替できているため)
- 本番投入判断: GPU(g6f系)インスタンスをth15の標準録画環境として採用するかの意思決定(コスト・運用手順の確立を含む)
- GPU検証が完了すればCPU(c7i.4xlarge、$0.12〜0.18/h)とGPU(g6f系、$0.05〜0.08/h)のコスト・品質比較の結論を出す

## 変更ファイル

- 新規: `mods/th15_replay_autoplay/dllmain.cpp`, `mods/th15_replay_autoplay/build.bat`, `cloud/docker/aws/Dockerfile.th15`
- 変更: `scripts/25_record_replay_e2e_multigame.py`(`GAME_CONFIGS["th15"]`追加、`--max-duplicate-rate`のMENU_TIME_SCALE対応), `AGENTS.md`(th15の入力方式・録画出力先ルール・PulseAudio残置シンク・低速録画閾値バグを追記), `.dockerignore`(`games/th15/`除外を解除)
- 新規(ローカルのみ、gitignore対象): `prefixes/th15-wined3d-gl/`, `instances/th15-manual-test/`, `instances/th15-multigame-recording-test/`
- 新規(`/mnt/cache3`、リポジトリ外): `/mnt/cache3/sattori-th15-verify/th15_hard_fulllength.mp4`ほか
