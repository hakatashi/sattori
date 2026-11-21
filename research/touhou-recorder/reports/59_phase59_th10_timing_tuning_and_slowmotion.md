# フェーズ59: th10のメニュー操作タイミング短縮・低速録画機能の実装

日付: 2026-08-28

## 位置づけ

ユーザーからの3点の指示を実施した: (1) 音ズレは視聴確認済みとの報告を受領、(2) 低速録画機能(フェーズ47のth20方式)の先行実装・調査、(3) メニュー自動操作の待機時間をユーザー指定値に短縮。

## メニュー操作タイミングの短縮

フェーズ56で確立した待機時間(タイトルロゴ6000ms、Step0後1000ms、Down間隔500ms、Step2後500ms、Step3/4後700ms)に短縮した。旧設定との対比:

| 区間 | 旧(フェーズ56) | 新(フェーズ59、ユーザー指定) |
|---|---|---|
| タイトルロゴ待ち | 4500ms | 6000ms |
| Step0(Enter)後 | 5000ms | 1000ms |
| Down x2 各後 | 1000ms | 500ms |
| Step2(Enter)後 | 700ms | 500ms |
| Step3/4後 | 700ms(変更なし) | 700ms |

`mods/th10_replay_autoplay/dllmain.cpp`を修正し、mingw-w64で再ビルド後、`th10_07.rpy`(プラクティス6面固定リプレイ、シーケンス到達確認用)で3回連続実行し、いずれも「Replay一覧到達→1番目のリプレイ選択→再生開始」まで成功することを確認した(`runs/th10_bringup2/newtiming_verify1〜3.mp4`、重複フレーム率0.0%/0.2%/0.0%)。タイトルロゴの合計待ち時間は新設定の方が長い(6000ms vs 4500ms)ため、フェーズ56で判明した「ロゴ演出中の入力は空振りする」問題を踏まえても安定して機能したと考えられる。

## 低速録画機能の実装

### 適用可能性の確認

th20(フェーズ47)で実装した`fps_limiter_hook`(Direct3D9 `Present`のvtableフック)・`dsound_hook`(DirectSound `SetFrequency`のvtableフック)がth10にも適用できるか、まずインポートテーブルを確認した:

```bash
strings games/th10/th10.exe | grep -iE "^d3d[0-9]*\.dll$|^dsound\.dll$|^dinput8?\.dll$"
# => d3d9.dll, DINPUT8.dll, DSOUND.dll
```

th10もd3d9.dll・DSOUND.dllを使用しており、両フックがそのまま適用できる前提条件を満たしていた。

### 実装

`mods/th10_replay_autoplay/dllmain.cpp`にth20と同一設計のコードを移植した:

- `GetMenuTimeScale()`/`ScaledSleep()`: `FPS_LIMIT_TARGET_HZ`環境変数から`60.0/targetHz`のスケール係数を算出し、メニュー操作の全`Sleep()`をこれに置き換え
- `InstallFpsLimiterHook(60.0)`・`InstallDSoundHook(1.0)`をDllMainに追加(`FPS_LIMIT_TARGET_HZ`未設定時はscale=1.0で従来動作と完全互換)
- `build.bat`に`fps_limiter_hook.cpp`・`dsound_hook.cpp`を追加

`scripts/25_record_replay_e2e_multigame.py`側の`MENU_TIME_SCALE`・`POST_START_GRACE_SEC`・`STUTTER_PROBE_INTERVAL_SEC`・`sequence complete`待ちタイムアウトは元々`FPS_LIMIT_TARGET_HZ`環境変数からタイトル非依存で算出される実装だったため、th10側の追加対応は不要だった。

### 実機検証: th10でもth20と同じ性質を確認

```bash
FPS_LIMIT_TARGET_HZ=30 python3 scripts/25_record_replay_e2e_multigame.py --game th10 --replay th10_07.rpy \
    --record-seconds 20 --no-audio --max-attempts 1 --max-duplicate-rate 90 \
    --output runs/th10_bringup2/slowmo_30hz.mp4
```

結果、th20と同様に**Presentの間引きがゲーム内ロジック更新頻度と直結している**ことを確認した:

```
FpsMonitor: 150 GetDeviceState calls in 5008 ms (30.0 Hz)   # 通常60Hz → 正確に半分
CreateSoundBuffer: initial freq=44100 scaled=22050 setHr=0x00000000  # 音声も正しく半分にスケール
```

メニュー自動操作シーケンス(`ScaledSleep`)も正しく機能し、Replay選択から再生開始まで到達。重複フレーム率53.8%(60fps録画に対しゲーム進行が30fpsのため理論値50%相当、正常)。既定動作(`FPS_LIMIT_TARGET_HZ`未設定)への影響が無いことも別途確認済み(`slowmo_baseline.mp4`、重複フレーム率0.0%)。

## 未実施(次フェーズへの持ち越し)

- CPU使用率削減効果の定量測定(th20のフェーズ47で行った`ps -o %cpu`によるベースライン比較)。ローカル環境では既に重複フレーム率0.0%と良好なため優先度は低いが、クラウド実機検証で処理落ちが確認された場合はこの機能で対処する想定
- スロー化録画を等倍相当に戻す変換(`scripts/47_descale_th20_slowmo.py`相当)のth10向け動作確認(スクリプト自体はタイトル非依存の汎用実装のはずだが未検証)
- クラウド実機検証(AWS、次フェーズで実施予定。ユーザーからスポット価格$0.2/hour未満・1並列までは事前許可不要との指示を受領)
