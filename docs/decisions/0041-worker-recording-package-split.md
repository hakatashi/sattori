# 0041. worker の録画パイプラインを `recording/` パッケージへ分割し、`record_thNN.py` はシムにする

- **状態**: 有効
- **決定日**: 2026-08-31
- **対象**: worker
- **関連**: Issue #188、Issue #201

1550行まで肥大化した `worker/recording_common.py` を責務ごとの11モジュールへ分割し、
6つの `record_thNN.py` で完全一致していた `main()` を `recording/cli.py` へ集約した。
**既存の decisions / reports が `recording_common.xxx` と書いている関数の現在地は §「旧名の
対応表」にある** —— それらは不変ドキュメントなので書き換えていない。

## 背景

`recording_common.py` は th08 対応（Issue #13）の際に「th07/th08 共通の録画パイプライン」
として切り出されたファイルだった。その後 th06・th11・th10・th20 の対応、thprac の
アタッチ（Issue #105・#110）、低速録画（Issue #68）、デシンクの事後検証（Issue #103）、
タイムアウト打ち切りの記録（Issue #161）、Wine 後片付けの強化（Issue #186）が積み増され、
Xvfb の起動からスコア照合・ffmpeg の実行・リトライ制御までが1ファイルに同居していた。
責務の境界はコード上は分かれているのに、**ファイルが1つなので「どこを触ると何に波及するか」
がファイル単位では分からない**状態になっていた（Issue #201）。

同時に `record_thNN.py` 6ファイルの `main()` は、th06/07/08/10/11 が完全一致、th20 だけ
`--max-duplicate-rate` の help 文字列が1箇所違うだけという重複になっており、CLI 引数を
1つ足すたびに6ファイルを編集する必要があった（Issue #188）。`build_config()` の先頭5行
（`SATTORI_*` 環境変数の解決と `injector_path` / `hook_dll_path` / `wineprefix` の組み立て）も
`game_id` から機械的に決まる同じ導出の書き写しだった。

## 決定

### `recording/` パッケージ（11モジュール）

モジュールの一覧と役割は [`worker/README.md`](../../worker/README.md) §2 にある。境界の基準は
2つだけ:

- **画素比較そのものの閾値は `vision.py`、ポーリングの回数・秒数は `pipeline.py`**。
  `*_CONSECUTIVE_REQUIRED` は `POLL_INTERVAL_SEC` との積で初めて意味が決まるため、
  ループを回す側に置く。
- **パッケージ内は `from .process import kill_wine_and_wait` と名前で import する**。
  したがってテストの monkeypatch は「定義側」ではなく**使う側**のモジュールに当てる
  （`pipeline.kill_wine_and_wait`）。テストファイルもモジュールと1対1に分割してある。

フラットな `recording_*.py` を並べる案ではなくパッケージにしたのは、`Dockerfile` の `COPY` が
`COPY recording/ /app/recording/` の1行で済み、**モジュールを足したときの COPY 漏れが
構造的に起きなくなる**ため（th10 対応時に実際に踏んでいる）。

### `record_thNN.py` は残し、シムにする

6ファイルは削除せず、「そのタイトルでしか成り立たない `GameConfig` の値」だけを持つ
25〜36行のシムにした（合計 748行 → 176行）。`record.py --game thNN` へ統合しなかった理由は
「採らなかった選択肢」を参照。長大だったモジュール docstring は
[`worker/docs/titles/thNN.md`](../../worker/docs/titles/README.md) の部分集合で二重管理に
なっていたため、そちらへのポインタに置き換えた。

### `GameConfig.for_game()`

`game_id` から機械的に決まるパス類（instance_dir / game_dir_src / wineprefix /
injector_path / hook_dll_path）の導出をここへ集約した。**環境変数名・既定値・優先順位は
一切変えていない** —— `SATTORI_GAME_DIR` 等でゲームデータの置き場所を差し替える手順が
`docs/reports/` の再現コマンドに載っているため。

### `attempt_recording()` の分割

330行を処理段階ごとの4関数（`_launch_game` / `_settle_crop_geometry` /
`_monitor_until_end` / `_stop_and_mux`）へ機械的に切り出し、本体は96行になった。
**監視ループの中身（テンプレート照合と画面静止の二重分岐）には触っていない。**

`_EndDetection`（終了検知の参照画像とマスク）を `_monitor_until_end` の中ではなく
呼び出し側で組み立てているのは、**マスク構築で例外が出たときに ffmpeg が起動済みだと
後片付けの対象から漏れて取り残される**ため。分割前の順序（座標確定 → マスク構築 →
ffmpeg 起動）をそのまま保っている。

## 根拠

振る舞いが変わっていないことは以下で確認した。

- 移動した43個の定義のうち、`GameConfig` と `__post_init__` 以外の**41個は1文字も
  変わっていない**（AST で本文を比較）。
- `attempt_recording()` から出力されうるログ35件の集合が、分割の前後で一致する。
- 既存のユニットテスト229件が全件パスする（分割前と同数）。`tests/test_record_thNN.py`
  6件が `for_game()` 導入の回帰検知として効く。
- 実機スモークテスト: [`docs/reports/2026-08-31-recording-package-split-verification.md`](../reports/2026-08-31-recording-package-split-verification.md)

`end_template_path` の既定値だけは `__file__` 起点から `WORKER_ROOT` 起点へ直す必要があった。
`recording/config.py` のまま `__file__` を使うと `worker/recording/assets/...` を指すが、
**ファイルが無くても例外は出ず** `load_end_template()` が `None` を返して画面静止のみ判定へ
静かにフォールバックするため、終了検知の劣化としてしか表面化しない
（[`0011`](0011-replay-end-template-matching.md)）。

## 採らなかった選択肢

- **`record.py --game thNN` の1本に統合し、タイトル定義を宣言的テーブルにする**。
  最も重複が減るが、`docs/reports/` の実機検証記録に載っている
  `python3 record_th20.py --replay-path ...` という再現コマンドが動かなくなる。reports は
  不変ドキュメントなので追随して書き換えられない。加えて `entrypoint.py` の
  `RECORDING_SCRIPTS` 許可リスト（`job.game` 由来の値から任意のパスを組ませないための
  防御）を作り直すことになる。**シムを残せば重複は解消しつつ両方が保てる**ため見送った。
- **`main()` だけ共通化して `build_config()` の重複は残す**。差分は最小だが、
  タイトル追加時に「6ファイルに書き写された同じ導出」を1つ増やす構造が残る。
- **終了検知の状態機械を `EndDetector` クラスへ抽出する**。ループ内の二重分岐が整理でき
  単体テストも書けるようになるが、録画パイプラインの中核であり実機検証の負担が大きい
  （`AGENTS.md` §3）。今回は「分割」に絞り、機械的な関数分割までに留めた。
- **`docs/decisions/` と `docs/reports/` の `recording_common.xxx` 参照も一括で書き換える**。
  どちらも不変ドキュメントなので触らず、下の対応表で引けるようにした。

## 旧名の対応表

既存の decisions / reports は `recording_common.py` の名前で書かれている。現在地は以下。

| 旧 | 現在 |
| --- | --- |
| `recording_common.GameConfig` / `XVFB_SCREEN` | `recording.config` |
| `slow_motion_scale` / `scaled_poll_count` / `duplicate_rate_threshold_for_raw` | `recording.timing` |
| `ensure_xvfb` / `prepare_instance` / `resolve_appdata_dir` / `apply_vpatch_ini_overrides` / `build_injector_cmd` | `recording.instance` |
| `find_live_game_pid` / `kill_wine_and_wait` / `attach_thprac` / `thprac_attached` | `recording.process` |
| `find_window` / `wait_for_stable_geometry` | `recording.window` |
| `wait_for_log_marker` / `scan_fps_runaway` / `read_verified_scores` / `check_replay_desync` / `GAME_SCORE_MULTIPLIERS` | `recording.modlog` |
| `grab_frame` / `mad` / `mad_masked` / `build_still_mask` / `load_end_template` / `build_end_template_mask` | `recording.vision` |
| `build_video_ffmpeg_cmd` / `build_audio_ffmpeg_cmd` / `mux_audio_video` / `measure_duplicate_rate` | `recording.ffmpeg` |
| `save_progress_snapshot` / `write_desync_result` / `write_timeout_result` | `recording.artifacts` |
| `attempt_recording` / `record_with_retry` / `MAX_ATTEMPTS_DEFAULT` | `recording.pipeline` |
| `log_with_prefix` | `recording.cli` |

## 影響範囲

- `worker/recording/`（本体）、`worker/record_thNN.py`、`worker/entrypoint.py`、
  `worker/Dockerfile`（`COPY recording/`）、`worker/tests/`
- 仕様は [`worker/README.md`](../../worker/README.md) §2・§10。タイトル固有の背景は
  [`worker/docs/titles/`](../../worker/docs/titles/README.md)
- **モジュールを1つ足すときに Dockerfile を触る必要は無い**（`COPY recording/` が拾う）。
  逆に `worker/` 直下へ新しいトップレベルスクリプトを足す場合は従来どおり `COPY` 行に
  名前を追加すること。
