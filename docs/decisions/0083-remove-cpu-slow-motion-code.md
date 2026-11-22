# 0083. CPU実時間（低速）録画専用のコードを削除し、削除したコードは git の履歴に任せる

- **状態**: 有効
- **決定日**: 2026-11-23
- **対象**: packages/shared / apps/api / apps/web / worker（Python・MOD）/ docs
- **関連**: Issue #391、Epic #399、[`0064`](0064-cpu-slow-motion-and-g6-fallback-on-gpu-shortage.md)・
  [`0067`](0067-th06nc-cpu-slow-motion-and-drop-1080p.md)・[`0081`](0081-frame-sync-plan-for-th20-and-th06nc.md)

Issue #390 で全タイトルのCPUの段がフレーム同期になり、**CPUで実時間録画する段がなくなった**。実時間録画が残るのは
GPUの段（倍速・等倍）だけなので、低速録画（1未満の倍率）にしか使わないコードを削除した。**知らずに戻すと、使われない
分岐（倍率の伸ばす方向・重複率の閾値の換算など）が各所に復活する。**

## 削除したもの

- `RecordingSpeed` 型の `1/2`・`1/3`（`SLOW_MOTION_RECORDING_SPEEDS`、`isSlowMotionRecording()`、低速の実時間効率）、
  段の `speedByDifficulty`（使うのは th15 Extra の 1/3 倍速だけだった）、`recordingSpeedForStep()`の難易度引数。
- ワーカー（Python）: `timing.py` の低速の頭打ち（`MAX_SLOW_MOTION_SCALE`）・`SLOW_MOTION_MAX_DUPLICATE_RATE`・
  `duplicate_rate_threshold_for_raw()`・`scaled_timeout_sec()`、`GameConfig.slow_motion_speed_hack`（th13・th06nc）。
  `FPS_LIMIT_TARGET_HZ` が60未満でも `recording_time_scale()` は 1.0 を返す。
- MOD: `core/time_scale.h` の `StartupTimeout`（伸ばす方向だけだった。各タイトルの起動待ちは定数に戻した）と、
  `MenuScaleFor()` の伸ばす方向（60Hz以下は等倍）。
- フロントの低速の表示（1/2 倍速の文言整形）。

## 残したもの

- **倍速（GPUの段）の経路すべて**: `time_scale < 1`、`SPEED_HACK_MULTIPLIER`、音声周波数の拡縮、`MenuScaleFor()` の縮める方向。
- **重複フレーム率による処理落ちの判定とリトライ**（`record_with_retry`）。GPUの実時間の段が使う。GPUで処理落ちの実績が
  無いとは言えない（`docs/known-limitations.md` §3・#93）ので、削除は見送った。閾値の換算だけ削除した。
- **`convert.py` の `time_scale > 1` を等倍へ戻す処理と、`entrypoint.py` のチェックポイントのメタデータの読み取り**。
  デプロイ前に低速録画で作られた生データのチェックポイントからの再開（`sattori-time-scale` が `2.0` など）を壊さない
  ためで、費用がほぼゼロの汎用処理なので残した。
- 古いジョブレコードの `options.recordingSpeed` が 1 未満でも、`normalizeRecordingSpeed()` が等倍へ丸めるので壊れない。
  `RECORDING_PLANS` に1未満の倍率の段が無いことは `recordingPlan.test.ts` が保証する。

## 削除したコードは `research/archive/` に置かない

本番で使われていたコードは git の履歴で足りる（ユーザー判断、2026-11-23）。**公開ミラーは filter-repo を通すので
commit hash が変わる**。削除前のコードを参照するときは、`git log -S SLOW_MOTION_RECORDING_SPEEDS` のように
**識別子で履歴を検索する**か、private の sattori-dev 側の hash を使うこと。技術検証の経緯・実測は
`docs/reports/2026-11-05-cpu-slow-motion-*` と touhou-recorder reports/91・97 に残してある。
