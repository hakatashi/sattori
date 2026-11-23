# 0084. MOD統合テストの既定をフレーム同期キャプチャにし、決定性を使った検証項目を増やす

- **状態**: 有効
- **決定日**: 2026-11-23
- **対象**: worker / docs
- **関連**: [`0049`](0049-mod-integration-test-local-only.md)、[`0077`](0077-worker-frame-sync-recording-path.md)、
  `worker/docs/mod-integration-test.md`、`worker/tests/mod_integration/`

`worker/tests/mod_integration/run.py`は既定で`CAPTURE_MODE=frame_sync`で録画し、`checks.py`の検証項目
(最終状態の完全一致・被弾のゲーム内時刻・再生区間の厳しい基準・仮想ミキサの整合・出力動画の形式・
無音/真っ黒でないこと等)をすべて満たすことをOKの条件にする。従来の実時間の録画は`--capture-mode realtime`で残す。

## 背景

本番の主力の録画経路がフレーム同期に移った(Epic #399)ので、MODの退行検知もその経路で行うべきである。
さらに実時間の録画ではゲームの進みが実時間に依存し、重複フレーム率・実時間の被弾タイミング(許容3秒)・
スコアのポーリング(1秒間隔)といった粗い判定しかできなかった。フレーム同期はゲームがフレーム単位で
決定的に動くので、同じ入力から毎回同じ結果が出る値を厳密に比べられる。

## 決定

- 既定をフレーム同期にする。`run.py`は`CAPTURE_MODE`を子プロセスへ渡すだけで、`record_thNN.py`・
  `recording/`側に分岐は足さない(0077の「分岐の基準は`CAPTURE_MODE`だけ」と同じ)。
- 判定関数は副作用の無い`tests/mod_integration/checks.py`に置き、`tests/test_mod_integration_checks.py`で
  ユニットテストする(実機録画なしで判定ロジックの退行を拾える。CIで走る)。
- 基準値(`TITLES`)は2026-11-23にHakataMatrixで全13タイトルを2回録画して採り、2回で一致することを確認した
  (最終状態は完全一致、被弾時刻は±0.4秒、再生区間は±0.1秒)。

## 根拠

- **被弾時刻は実時間でなくゲーム内の時刻で比べる**。ScoreMonitorのログ行にフレーム番号が無く、実時間は
  ゲームの進みと無関係(メニュー区間は等速・再生中は数百fpsの可変速)なので、実時間の経過秒で比べると
  基準が意味を持たない(th06で実時間の基準[84.1,121.1]に対しフレーム同期の実測は実時間で[36.9,43.6]だった)。
  MODログの`FrameSync: stats frame=N`(600フレームごと)から実時間→フレームを線形補間して換算する。
  MODを変更してログにフレーム番号を足せば誤差は消せるが、全DLLの再ビルド・再配備が要るため見送った。
- **th20の`refill_timeouts`は許容する**(`max_refill_timeouts`)。BGMの周回境界で起きる仕様で音欠けは無い
  (touhou-recorder reports/110)。他タイトルは0を要求する。

## 採らなかった選択肢

- **フレーム画像のゴールデン比較**: 再生開始フレームの特定が数フレームずれる(メニュー区間の実時間→フレーム換算)
  ため、画素の一致は取れず、ffmpeg/Mesaの更新で壊れやすい。見送った。
- **フレーム同期だけにして実時間を消す**: 実時間の経路はGPU倍速の段などで本番に残っているので、MODの退行検知も
  `--capture-mode realtime`として残した。

## 影響範囲

`worker/tests/mod_integration/{run,checks}.py`、`worker/docs/mod-integration-test.md`、
`worker/tests/fixtures/mod-integration/README.md`。リプレイを差し替えたら`TITLES`の基準値(観測値は
`run.py`が`観測値:`として毎回出す)を採り直すこと。
