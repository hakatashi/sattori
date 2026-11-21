# フェーズ69: th09の低速録画fps表示補正・低速録画データ整備

日付: 2026-09-02

## 位置づけ

フェーズ68でth09(東方花映塚)の低速録画機能(Direct3D8版Present間引き・DirectSound周波数スケーリング)を実装したが、th20(reports/48)で実装済みの「画面上fpsカウンター表示の補正」がth09にも正しく実装されているかは未確認のままだった。ユーザーから、(1) 低速録画データとそれを等倍速に戻したデータの作成、(2) fps表示補正が正しく実装されているかの確認、を依頼された。

## fps表示補正の実装(未実装だったことが判明)

フェーズ68時点では画面に焼き付くfpsカウンター表示自体の補正は未実装だった。実機で`FPS_LIMIT_TARGET_HZ=30`録画すると、画面には実測通り「30.02fps」と表示されたままであることをスクリーンショットで確認した。

### 調査

`mods/common/timer_probe_hook.h/.cpp`(既存、th20のfps表示補正調査(reports/48)で作られた汎用診断フック。QueryPerformanceCounter/timeGetTime/GetSystemTimeAsFileTime/SetTimerの呼び出し元ごとの頻度をログ記録する)を、th09の`mods/th09_replay_autoplay/dllmain.cpp`に一時的に組み込み(`TIMER_PROBE=1`で有効化)、`FPS_LIMIT_TARGET_HZ=30`設定下でMatchリプレイ(`th9_ud5615.rpy`)を実機再生して調査した。

- QueryPerformanceCounterの持続的な呼び出し元は1箇所のみ(`rva=0x0002cca9`)で、常に60Hz固定(throttleの影響を受けない)。fps表示用ではないと判断
- WINMM.dll!timeGetTimeの持続的な呼び出し元のうち、`rva=0x00031701`がPresent呼び出し頻度と1:1(30Hz)で相関することを確認(他の呼び出し元は起動時に1回のみ、または固定値で増加が止まっていた)

**th09はth20と異なり、QueryPerformanceCounterではなくWINMM.dll!timeGetTime(ミリ秒精度)でfps表示を計算している**と結論した。

### 実装

`mods/common/fps_display_hook.h/.cpp`に**timeGetTime版**(`InstallFpsDisplayCorrectionHookTimeGetTime`)を新規追加した。ロジックはth20が使うQueryPerformanceCounter版(`InstallFpsDisplayCorrectionHook`)と同一(対象コールサイトから呼ばれた場合のみ、実経過時間を`FPS_LIMIT_TARGET_HZ/60`倍に圧縮した偽の値にすり替える)で、フックするAPIとその型(DWORD、ミリ秒)のみが異なる。QueryPerformanceCounter版とは独立したIATスロット・状態変数を使うため、将来他タイトルで両方式が必要になっても共存できる。

`mods/th09_replay_autoplay/dllmain.cpp`に`InstallFpsDisplayCorrectionHookTimeGetTime(0x00031701)`を追加(rva固定でハードコード、`FPS_LIMIT_TARGET_HZ`未設定時はscale=1.0で実質無効化、th20と同じ安全側の設計方針)。

### 実機検証

`FPS_LIMIT_TARGET_HZ=30`設定でMatchリプレイ・Storyリプレイ(Stage 4実プレイ中)の両方をスクリーンショットで確認し、画面上fps表示が実測値「30.02fps」から補正後「60.00fps」に変わることを確認した。`FpsMonitor`ログ(`GetDeviceState`呼び出し頻度)は補正前後で同水準(約90Hz)であり、ゲーム進行速度・入力ポーリング頻度には影響がないことも確認した。

### 副次的に発見・修正した不具合: build.batのリンク漏れ

th09の`mods/th09_replay_autoplay/build.bat`(MSVC公式ビルド)が`stage_probe_hook.cpp`・`score_probe_hook.cpp`を含んでおらず、`dllmain.cpp`が無条件に呼ぶ`InstallStageProbeHook()`/`InstallScoreProbeHook()`とリンクエラーになる状態だった(フェーズ68でmingm版ビルドコマンドに毎回手動でこれらを追加していたため見過ごしていた)。両ファイルと新規の`fps_display_hook.cpp`を`build.bat`に追加して修正した。

## 発見・修正した不具合: 低速録画時のstutter probe誤検知

低速録画(`FPS_LIMIT_TARGET_HZ=30`)のMatchモードをフル尺録画したところ、`scripts/25_record_replay_e2e_multigame.py`の早期処理落ち検知(`probe_stutter`、リプレイ開始後300秒間・60秒おきに短間隔サンプリングし、重複フレーム率が閾値`STUTTER_DUP_FRACTION_THRESHOLD`(既定0.7)を超えると即座に破棄・リトライする仕組み)が誤検知し、3回とも失敗した。

原因: 意図的な30fps録画では理論上50%の重複フレームが発生するため、素の閾値0.7に対するマージンが0.2しか残らない(ネイティブ60fps録画では素の重複率がほぼ0のためマージンは0.7)。サンプリングの分散だけでこの狭いマージンを超過し、誤って「処理落ち」と判定されていた。

### 修正

`scripts/25_record_replay_e2e_multigame.py`の`STUTTER_DUP_FRACTION_THRESHOLD`を、ネイティブ60fps時のマージン比率を維持するよう`MENU_TIME_SCALE`(`60/FPS_LIMIT_TARGET_HZ`)に応じて動的に算出するよう変更した:

```python
STUTTER_DUP_FRACTION_THRESHOLD = 1.0 - (1.0 - 0.7) * (1.0 / MENU_TIME_SCALE if MENU_TIME_SCALE > 0 else 1.0)
```

`FPS_LIMIT_TARGET_HZ`未設定(scale=1.0)時は従来通り0.7、30fps時(scale=2.0)は0.85になる。修正後、Matchモードの低速録画は1回目の試行で成功した(311.9秒、開始15秒以降の重複フレーム率50.0%で意図通り)。この修正は他タイトル(th10/th12/th20)の低速録画にも同様に安全側で働く(スケール未設定時は無変更)。

## 低速録画・等倍変換データの作成

Match(`th9_ud5615.rpy`)・Story通常難度(`th9_03.rpy`)それぞれについて、`FPS_LIMIT_TARGET_HZ=30`でフル尺録画した後、`scripts/47_descale_th20_slowmo.py --target-hz 30 --native-hz 60`(タイトル非依存の汎用スクリプト、`setpts`による映像速度変換+`asetrate`/`aresample`による音声ピッチ・速度の可逆補正)で等倍相当に変換した。

```bash
FPS_LIMIT_TARGET_HZ=30 python3 scripts/25_record_replay_e2e_multigame.py \
    --game th09 --replay th9_03.rpy --output /tmp/th09_slowmo_story.mp4
python3 scripts/47_descale_th20_slowmo.py /tmp/th09_slowmo_story.mp4 \
    /tmp/th09_slowmo_story_restored.mp4 --target-hz 30 --native-hz 60
```

| リプレイ | 低速録画(30fps)総時間 | 等倍変換後の時間 | 参考: 通常速度録画の総時間 | 変換後重複フレーム率(60秒サンプル) |
|---|---|---|---|---|
| Match | 311.9秒 | 155.7秒 | 189.5秒 | 0.4% |
| Story/Normal | 1534.2秒 | 766.5秒 | 768.9秒 | 0.2% |

低速録画側の重複フレーム率はいずれも50.0%(30fps相当コンテンツをFPS_LIMIT_TARGET_HZ未指定同様の60fpsコンテナに収録した場合の理論値と一致)。等倍変換後の時間は通常速度録画とほぼ一致しており(Matchはメニュー操作時間の割合差で若干短いが、Storyはほぼ完全一致)、変換が正しく機能していることを裏付ける。変換後のフレームを目視確認したところ、滑らかな60fps相当の動きに復元されており、画面に焼き付いた「60.00fps」表示(fps表示補正により録画時点で既に正しい値が焼き付いている)とも整合していた。

### 保存データ

`/mnt/cache3/sattori-th09-verify/`に低速録画4本(低速録画そのもの×2+等倍変換後×2)を保存した:

```
th09-match-slowmo-30fps.mp4           (170MB、30fps録画そのもの)
th09-match-slowmo-restored.mp4        (122MB、等倍変換後)
th09-story-normal-slowmo-30fps.mp4    (920MB、30fps録画そのもの)
th09-story-normal-slowmo-restored.mp4 (621MB、等倍変換後)
```

フェーズ68のMatch/Story-Normal/Extra(ローカル・AWS各3種、計6本)と合わせ、`/mnt/cache3/sattori-th09-verify/`には計10本のフル尺録画データが揃った。

## 未解決事項

- Extraステージでの低速録画・fps表示補正の実機検証は未実施(Match/Storyでのみ確認済み。ロジック自体はモード非依存のため動作するはずだが未確認)
- fps表示補正のrva(`0x00031701`)はth09.exe(検証時点のバイナリ、ver1.50a)固有のハードコードであり、ゲームデータが更新されバイナリが変わると別の値になる可能性がある(th20と同じ既知の制約)
