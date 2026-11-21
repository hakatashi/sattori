# フェーズ63: th12の低速録画機能実装・実機検証

日付: 2026-08-31

## 位置づけ

フェーズ62でExtraステージのフル尺録画において処理落ち(重複フレーム率26.2%、FpsMonitor最小15.8Hz)が判明したため、AGENTS.mdの新規タイトル対応チェックリスト項目7(低速録画機能)を実装・検証した。項目9(AWSクラウド実機検証)は未着手。**このフェーズだけでは「対応完了」を報告しない**こと。

## 実装

th12.exeはd3d9.dll・DSOUND.dllを使用する(インポートテーブルで確認済み)ため、th10(reports/59)・th20(reports/47)と同じ`mods/common/fps_limiter_hook.*`(Present vtableフックによるフレームレート制限)・`mods/common/dsound_hook.*`(SetFrequency vtableフックによる音声速度スケーリング)がそのまま適用できた。`mods/th12_replay_autoplay/dllmain.cpp`に以下を追加:

- `InstallFpsLimiterHook(60.0)` / `InstallDSoundHook(1.0)`(`FPS_LIMIT_TARGET_HZ`未設定時はscale=1.0で従来動作と完全互換)
- メニュー操作の各`Sleep`をth10と同じ`ScaledSleep`(`FPS_LIMIT_TARGET_HZ`に応じて待機時間をスケール)に置き換え

ビルドコマンド(mingw-w64):
```bash
i686-w64-mingw32-g++ -shared -O2 -o build/th12_hook.dll \
    dllmain.cpp \
    ../common/dinput_hook.cpp ../common/window_wait.cpp ../common/logging.cpp \
    ../common/fps_monitor.cpp ../common/fps_limiter_hook.cpp ../common/dsound_hook.cpp ../common/score_monitor.cpp \
    -static-libgcc -static-libstdc++ -static -luser32
```

## 短時間動作確認(`FPS_LIMIT_TARGET_HZ=30`、40秒録画)

`FpsMonitor`ログが29.6〜30.0Hzで安定(60Hzの半分)。`DirectSoundCreate8`フックで初期周波数が44100→22050、22050→11025へ正しくスケールされることを確認。録画フレームからEXTRA面プレイ中の映像(画面右下に「30.0fps」表示)を目視確認した。

## フル尺録画検証(Extraステージ、th12_01.rpy、`FPS_LIMIT_TARGET_HZ=30`)

### 発生した問題: `--max-duplicate-rate`未指定によるリトライ地獄

`scripts/25`の既定`--max-duplicate-rate`(30%)のまま実行したところ、スロー化録画は理論上60fpsコンテナに対し30fps相当のコンテンツになるため重複フレーム率が約50%になるのが正常(th20のreports/47で既知の制約と同一)にも関わらず、「処理落ちの疑い」として3回ともリトライされ、約71分(24分×3回)を空費した。**`FPS_LIMIT_TARGET_HZ`使用時は`--max-duplicate-rate`を理論値(`100 - FPS_LIMIT_TARGET_HZ/60*100`、30Hzなら50%)以上に明示指定する必要がある**(reports/47で既に指摘されていた既知の制約だが、本フェーズでも再度踏み抜いた。**恒久対応としてscripts/25側での自動調整が引き続き望ましい**)。3回目の試行の成果物(`--max-duplicate-rate`のチェックに失敗しても出力ファイル自体は削除されず残る)を使って以降の検証を行った。

### 検証結果

- 総録画時間: 1422.2秒(通常速度録画766.3秒の約1.86倍、理論値2倍に近い)
- `FpsMonitor`ログ(284サンプル): 最小29.4Hz・最大30.2Hz、**28Hz未満のサンプルは0件**。通常速度録画で見られた処理落ち(最小15.8Hz、55Hz未満22/153件)が完全に解消された。
- `scripts/53_verify_replay_score.py`による記録スコア完全一致検証:

```
タイトル      : th12
リプレイ      : th12_01.rpy (Extra / Extra Stage Clear / koyi)
記録時スコア  : 195,699,630
再生時スコア  : 195,699,630 (内部値19,569,963×10, 最大195,699,630)
到達ステージ  : 7  残機: 2  グレイズ: 3,220
判定          : 一致(デシンクなし)
```

低速化してもリプレイデシンクは発生せず、記録スコアと完全一致した。

## 等倍相当への変換

既存の`scripts/47_descale_th20_slowmo.py`(ゲーム非依存の汎用ffmpeg処理)がそのまま使えた:

```bash
python3 scripts/47_descale_th20_slowmo.py \
  runs/th12_verification/th12_extra_slowmo_<epoch>.mp4 \
  runs/th12_verification/th12_extra_slowmo_descaled.mp4 \
  --target-hz 30 --native-hz 60
```

変換後の動画長710.5秒(通常速度録画766.3秒と近似、メニュー操作待機時間の差分等により完全一致はしない)。t=300秒のフレームを目視確認したところ、Extraボス(封獣ぬえ)戦のスペルカード画面が正しく再生されていることを確認した。

**th20のフェーズ48で対応したfps表示補正(録画内蔵fpsカウンターが「30.0fps」のまま残る問題)はth12では未対応**。等倍変換後の動画でも画面右下のfps表示は「30.0fps」のままで、実際の滑らかさ(60fps相当に復元済み)と数値が食い違う。本番運用に組み込む場合は同様の補正の要否を検討する必要がある。

## ディスク容量の考慮

作業時点でホストのディスク使用率が93〜94%と逼迫していたため、mux前の中間ファイル(`*.video.mp4`・`*.audio.m4a`)と低速録画の短時間テスト(`th12_slowmo_test_*.mp4`)を削除した。最終成果物(`th12_extra_slowmo_*.mp4`・`th12_extra_slowmo_descaled.mp4`および前フェーズの`th12_normal_full_*.mp4`・`th12_extra_full_*.mp4`)は保持。

## 未実施(次フェーズ以降の課題)

AGENTS.mdの新規タイトル対応チェックリストのうち、以下が未着手:

9. AWSクラウド実機検証(推奨インスタンスタイプの確定)。Extraステージで処理落ちが確認された(フェーズ62)ため、他タイトル同様4vCPU以上の複数インスタンスタイプでの比較検証が必要。低速録画機能が使えるようになったため、インスタンスタイプが力不足だった場合の代替手段としても選択肢に入れられる

これが完了するまで「th12対応完了」を報告しないこと。
