# 倍速録画対応MOD・パイプラインの等倍録画への回帰確認（ローカル、CPU描画）

- **検証日**: 2026-09-30
- **対象**: Issue #288 PR1（touhou-recorder reports/84〜90から移植したMOD群——`speed_hack_hook`・
  `dsound_hook`（同期マーカー）・`wasapi_hook`・`fps_display_hook`の更新——と録画パイプライン）が、
  **等倍（CPU描画・Xvfb）の録画を壊していないか**
- **環境**: HakataMatrix（自宅ワーカー機、`sattori-home-worker`停止中）。ホスト直接実行の
  MOD統合テスト（`worker/tests/mod_integration/run.py`、`worker/README.md` §14）。
  main版DLLとの比較は同じPythonパイプラインで`SATTORI_MOD_DIR`だけを差し替えて行った
- **結論**: **th10/th12で新規に組み込んだ`fps_limiter_hook`が等倍でも60fpsで間引き、VsyncPatchの
  フレーム制御と二重になってゲーム進行が遅れる退行があった**（修正済み）。それ以外に新MOD起因の
  退行は見つからなかった。同期マーカーは等倍でも検出でき、mux後の残差は±1ms以内。

倍速録画そのもの（GPU描画・NVENC）はこの環境では検証できない（本番E2E検証で行う）。

## 結果

全タイトル1回ずつの統合テスト（th06nc・th15はGPU必須のためこの環境では対象外）:

| タイトル | 結果 | 備考 |
| --- | --- | --- |
| th06 / th06c / th09 / th11 / th128 / th20 | OK | |
| th07 | NG（Wineクラッシュ） | リプレイ開始直後のロード画面でth07.exeがpage fault（`0x0045F095`）。下記の反復で再現せず |
| th08 | NG（デシンク判定） | 下記の反復（新DLL3回）では再現せず |
| th10 | NG（被弾タイミング+4.1秒） | **`fps_limiter_hook`の二重制御による退行**。修正後は基準値と完全一致 |
| th12 | OK（被弾タイミング+1.1〜2.1秒、許容内） | th10と同じ原因。修正後は基準値と完全一致 |

新旧DLLのA/B（th07・th08各3回ずつ、交互に実行）と、新DLLのth07の追加6回:

| 条件 | th07 | th08 |
| --- | --- | --- |
| 新DLL | デシンク判定3/9、Wineクラッシュ1/10、被弾タイミングは全回で同一 | 3/3 OK |
| main版DLL | デシンク判定2/3 | 3/3 OK |

- **th07のデシンク判定はmain版でも起きる既存の揺らぎ**。新旧とも最終観測スコアは同じ357,380
  （表示値3,573,800、記録値3,581,800）で、1秒間隔のスコアサンプリングがリプレイ終了直前の
  最終加算を取りこぼしている。リプレイ自体はずれていない。
- **th07の「被弾タイミング+6.0秒」はテストハーネスの見かけ上のずれ**。`sequence complete`から
  最初の被弾までは新旧とも108.8秒で同一。起動直後のスコア監視のゴミ値サンプルが、main版では
  `graze`が負で除外され、新DLL（メモリ配置が変わった）では`graze=164`とあり得る値のため除外
  されず、基準時刻が6秒早まっていた。
- **th07のWineクラッシュ**は新DLLで10回中1回（main版3回中0回）。同期マーカーの再生（約4秒）と
  リプレイ開始時のロードが重なったタイミングだったが、統計的に新DLL起因とは言えない。本番では
  Wineクラッシュ検知（Issue #267）で破棄・リトライされる。

## 原因と修正（th10/th12）

`fps_limiter_hook`は`FPS_LIMIT_TARGET_HZ`未設定でも60fpsでPresentを間引く（th20のAWSでの
フレームペーシング崩れ対策として作られたため）。th10/th12はVsyncPatchを注入しており、
フレーム制御はvpatchが担う。touhou-recorderでは低速録画検証（フェーズ58・62）以来このフックを
常時入れていたが、評価指標が重複フレーム率だけでゲーム進行の遅れは測っていなかった。
`FPS_LIMIT_TARGET_HZ`が60以外（倍速時）のときだけ入れるよう修正した
（`worker/mods/th10_replay_autoplay/dllmain.cpp`・`th12_replay_autoplay/dllmain.cpp`）。

## 残った課題

- MOD統合テストのth07デシンク判定と被弾タイミングの基準時刻は、DLLに関係なく揺らぐ
  （判定ロジックの改善は別Issue）。
- 検証データ: `/mnt/cache3/sattori-speedup-verify/`（`mod_integration_1x.log`・`ab.log`・
  `exp/th07_new_soak.jsonl`、MODログの写し）。
