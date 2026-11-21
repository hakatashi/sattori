# フェーズ72: th128の低速録画機能の実機検証、thprac併用時のタイムアウトスケールバグ修正

日付: 2026-09-04

## 位置づけ

AGENTS.mdチェックリスト項目7(低速録画機能の実装・実機検証)を完了する。MOD側のフック(`InstallFpsLimiterHook`/`InstallDSoundHook`)はフェーズ70で既にインストール済みだったが、実機動作は未検証だった。

## 発見したバグ: thprac併用時、低速録画でthpracアタッチがタイムアウトする

`FPS_LIMIT_TARGET_HZ=30 python3 scripts/25_record_replay_e2e_multigame.py --game th128 --thprac --replay th128_ud0000.rpy --record-seconds 30 --no-audio ...`を実行したところ、`thprac のアタッチがタイムアウトしました`(60秒固定タイムアウト)→`ゲームウィンドウが検出できませんでした`で録画自体が失敗した。

原因は`attach_thprac()`の呼び出し(`scripts/25_record_replay_e2e_multigame.py`の旧760行目付近)が`timeout`引数を省略し既定値60秒のまま呼んでいたこと。低速録画時は`fps_limiter_hook`のPresent間引きビジーウェイトがCPUを占有し、ウィンドウ安定待ち等の実時間が延びることがth09(`reports/68`)で既に確認されていたのと同じ理由で、thprac自体のアタッチ処理(DLL注入・IPC)の実時間も延びていたと考えられる。他の待機処理と同様`MENU_TIME_SCALE`で timeout をスケールするよう修正した:

```python
if getattr(args, "thprac", False):
    attach_thprac(cfg, env, timeout=60 * MENU_TIME_SCALE)
```

修正後、同じ条件で`thprac アタッチ完了 (0.8s, pid=314368)`と即座に成功するようになった。この不具合はth128固有ではなく「`--thprac`と低速録画(`FPS_LIMIT_TARGET_HZ`<60)を併用する場合」全般に影響する(これまでth20の`--thprac`運用は低速録画と組み合わせて使われたことが無かったため未発覚だった)。

## 低速録画(30fps)の実機検証結果

`FPS_LIMIT_TARGET_HZ=30`での短時間録画(`--record-seconds 30 --no-audio`)で以下を確認した:

- `InstallFpsLimiterHook: IAT hook OK (target=30.00 fps)`・`InstallDSoundHook: IAT hook OK (freqScale=0.5000)`のログを確認
- `FpsMonitor`ログがメニュー中・プレイ中を通して安定して30.0Hz付近(27.2〜30.1Hz)を示した(等倍録画時の55〜60Hzのちょうど半分)
- `CreateSoundBuffer: initial freq=44100 scaled=22050`等、音声バッファの初期周波数が正しく半分にスケールされている
- 録画開始15秒以降の重複フレーム率が**50.2%**(60fps撮影に対し30fpsコンテンツを2回に1回複製キャプチャする理論値そのもの、th09の先例と同じ意味で「正常」と判定できる数値)

画面上のfpsカウンター表示(`30.0fps`)は未補正のまま(th09/th10/th12/th20で実装している`fps_display_hook`はth128にはまだ接続していない)。これは表示上の見た目だけの問題で、録画パイプラインの正常動作(フレームレート制御・音声ピッチ補正)には影響しない。RVA特定には`mods/common/timer_probe_hook.h`での実機調査が必要なため、次フェーズ以降の任意課題として持ち越す(このローカル開発機ではth128に処理落ちの兆候が無い=低速録画自体が本番で必須になる可能性は低いため、優先度は低いと判断)。

## 未完了・次フェーズへの持ち越し事項

1. fps表示補正(`fps_display_hook`)の接続 — 任意、優先度低
2. AWSクラウド実機検証(次フェーズで実施予定)

## 変更ファイル

- 変更: `scripts/25_record_replay_e2e_multigame.py`(`attach_thprac()`呼び出しに`timeout=60 * MENU_TIME_SCALE`を追加)
