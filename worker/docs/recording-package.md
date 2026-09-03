# 録画パイプライン(`recording/`)の構成

全タイトル共通の録画パイプライン本体である `recording/` パッケージの参照仕様。**録画の
挙動(ポーリング回数・画素比較の閾値・終了検知・自動リトライ)を変えるときに、どのモジュールを
触るかをここで確かめてから開くこと。** ワーカー全体の構成は
[`worker/README.md`](../README.md) §2、タイトル固有の事情は [`titles/`](titles/README.md)。

## 1. 責務

責務ごとに11モジュールへ分割してある(§2。分割の経緯は
[`0041`](../../docs/decisions/0041-worker-recording-package-split.md))。
Xvfb起動・クロップ座標の確定([`0012`](../../docs/decisions/0012-crop-geometry-after-window-stabilizes.md))・録画・
終了検知([`0011`](../../docs/decisions/0011-replay-end-template-matching.md))・fps暴走検知・
自動リトライ(既定3回)・映像/音声を別プロセスで録画し後でmuxする処理(reports/26)・
フックDLLより前の追加DLL注入(`GameConfig.extra_dlls`)・音声のジョブ専用sinkへの分離
([`0013`](../../docs/decisions/0013-per-job-pulseaudio-sink.md))を担う。

処理落ちの早期検知(stutter probe)は真陽性の実績が無く正常なリプレイも誤検知しうることが
判明したため削除済み([`0038`](../../docs/decisions/0038-remove-stutter-early-detection.md))。
代わりに、終了判定に画面静止を使わないend_template方式のタイトルへは、画面が5分静止したら
タイムアウト扱いで強制停止する早期検知を追加してある
([`0039`](../../docs/decisions/0039-end-template-freeze-timeout.md))。

## 2. モジュール一覧

**どこを触るか迷ったら、まずこの表で当たりを付けること。**

| モジュール | 役割 |
| --- | --- |
| `config.py` | `GameConfig` とその既定値の導出(`for_game()`)。パス類は `WORKER_ROOT` 起点 |
| `timing.py` | 低速録画(`worker/README.md` §5)の実時間スケーリングと、重複フレーム率の閾値換算 |
| `instance.py` | Xvfb 起動・instance ディレクトリの複製・`vpatch.ini` の上書き・注入コマンド |
| `process.py` | ゲームプロセスの探索・thprac のアタッチ・Wine の後片付け |
| `window.py` | ウィンドウ検出とクロップ座標の確定 |
| `modlog.py` | MOD が書き出すログの読み取り(マーカー待ち・fps暴走検知・スコア照合) |
| `vision.py` | 画面キャプチャと画素比較。**画素比較の閾値はここ**(ポーリング回数は `pipeline.py`) |
| `ffmpeg.py` | 録画・結合・重複フレーム率計測の ffmpeg/ffprobe 呼び出し |
| `artifacts.py` | 進捗・デシンク検証結果・タイムアウト有無のファイル書き出し(別プロセスへの受け渡し) |
| `pipeline.py` | 1回の録画試行(`attempt_recording()`)と自動リトライ(`record_with_retry()`)。**ポーリングの回数・秒数はここ** |
| `cli.py` | `record_thNN.py` が共有する CLI(引数定義・ロガー) |

テストは `tests/test_recording_<モジュール名>.py` と1対1に対応させる(monkeypatch の当て方を
含む規約は [`docs/runbooks/worker-local-recording.md`](../../docs/runbooks/worker-local-recording.md) §1)。
