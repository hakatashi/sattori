# フェーズ83: 録画パイプラインの `recorder/` パッケージ化

日付: 2026-09-17

## 背景

新規タイトルの録画検証には `scripts/25_record_replay_e2e_multigame.py` を使ってきた。もともとフェーズ25で「th07とth08を同じパイプラインで比較する」ために作られたスクリプトだが、その後フェーズ26〜82のあいだに録画関連の知見が出るたびに追記・拡張を続けた結果、**1ファイル1,933行**まで肥大化していた。

肥大化の内訳(旧ファイル内の主な塊):

| 範囲 | 内容 | 行数 |
|---|---|---|
| 33〜400行付近 | `GAME_CONFIGS`(12タイトル分の設定辞書、根拠コメント込み) | 約330 |
| 400〜440行付近 | グローバル定数(閾値・タイムアウト・時間スケール) | 約40 |
| 443〜1010行付近 | 環境準備・プロセス操作・画素比較・マスク生成の関数群 | 約570 |
| 1013〜1533行 | `attempt_recording()`(1関数で約520行) | 約520 |
| 1536〜1783行 | ステージチャプター生成 | 約250 |
| 1785〜1933行 | 重複フレーム率計測・統計モード・`main()` | 約150 |

とくに `attempt_recording()` は起動・ウィンドウ確定・ffmpeg起動・監視ループ・停止/mux・分類までを1関数で抱えており、変更時に全体を読み直す必要があった。今後も新規タイトル対応・クラウド検証が続くため、**汎用の録画検証モジュールとして再構築する**ことにした。

## 方針

- 実装本体を `scripts/` の外、リポジトリ直下の **`recorder/` パッケージ**へ移す(もはや「スクリプト」と呼べる規模ではないため)。
- **機能は一切変えない**。閾値・タイムアウト・ffmpegコマンド・ログ出力形式・CLIフラグ・終了コードを維持する。
- 責務の切り方とモジュール名は、本PoCをもとに構築された本番サービスSattoriの録画パイプライン `../sattori/worker/recording` に揃える(片方で見つかった不具合をもう片方へ移植しやすくするため)。
- `scripts/25_record_replay_e2e_multigame.py` は **`recorder.cli.main()` を呼ぶだけの互換シム**として残す。過去レポート46本・`cloud/docker/aws/entrypoint_multigame.py`・`scripts/50_run_thprac_desync_batch.sh` がこのパスを参照しているため。

## モジュール構成

```
recorder/
  __init__.py   設計の全体像(パッケージdocstring)と公開API
  config.py     GameConfig(タイトルごとの差分)とパイプライン共通の既定値・build_env()
  games.py      タイトル別の設定レジストリ(12タイトル、値の根拠コメント込み)
  options.py    RecordingOptions(1回の録画実行への指示)
  timing.py     低速録画(FPS_LIMIT_TARGET_HZ)の実時間スケーリング
  log.py        共通ロガー
  instance.py   ensure_display / prepare_instance / build_injector_cmd
  process.py    find_live_game_pid / attach_thprac / kill_wine_and_wait
  window.py     find_window / wait_for_window / move_into_screen / recheck_origin_before_recording
  modlog.py     wait_for_log_marker / scan_fps_runaway
  vision.py     grab_frame / read_poll_frame(s) / mad_masked / 各種マスク生成 / テンプレート読み込み
  stutter.py    probe_stutter(処理落ちの早期検知)
  ffmpeg.py     build_video_ffmpeg_cmd / build_audio_ffmpeg_cmd / mux_audio_video / measure_duplicate_rate
  chapters.py   MODログの StageMarker から動画チャプターを生成
  pipeline.py   attempt_recording(段階ごとに _launch_game / _settle_geometry / _build_detection /
                _start_capture / _monitor_until_end / _stop_capture / _classify へ分割)
  runner.py     record_with_retry / record_fixed_seconds / run_stats
  cli.py        argparse と main()
```

行数は合計2,714行(旧1,933行から増えているのは、モジュールごとのdocstringと責務の説明を厚くしたため)。1ファイルあたりは `pipeline.py` の525行が最大で、それ以外は全て366行以下。

### 主な設計変更(挙動は不変)

1. **`GAME_CONFIGS` の辞書を `GameConfig` dataclass 化**(`recorder/config.py` / `recorder/games.py`)。
   - `cfg.get("skip_origin_move_if_fits")` のような文字列キー参照が `config.skip_origin_move_if_fits` になり、フィールドの意味・既定値・根拠コメントが定義側に集約された。
   - `game_exe` / `process_name` / `hook_dll` / `hook_dll_src` / `log_path` は `game_id` から `__post_init__` で導出するようにしたため、`games.py` には**そのタイトルでしか成り立たない値だけ**が残る(th06の `東方紅魔郷.exe` や th06c の `injector64.exe` など)。
   - 移植の正しさは、旧ファイルの `GAME_CONFIGS` を `importlib` で読み込んで新レジストリと全フィールド突き合わせるスクリプトで確認した(全12タイトル・全フィールド一致、下記「検証」参照)。
2. **CLI引数の受け渡しを `RecordingOptions` dataclass 化**(`recorder/options.py`)。パイプライン本体が argparse の `Namespace` に依存しなくなり、Pythonから直接呼べるようになった。`separate_audio` / `inline_audio` / `video_target` / `audio_target` / `poll_raw_path` の導出はここへ集約。
3. **`attempt_recording()`(約520行)を段階ごとのヘルパーへ分割**。各段階の戻り値は `_Capture` / `_Detection` / `_Monitor` の小さなdataclassで受け渡す。最終結果も dict から `RecordingResult` dataclass にした(キーのtypoが即エラーになる)。
4. **実行モードを `runner.py` へ分離**。旧 `main()` が持っていた「通常のリトライ付き録画」「`--record-seconds` の固定秒数録画」「`--stats-runs` の統計取り」の3モードが、それぞれ `record_with_retry()` / `record_fixed_seconds()` / `run_stats()` になった。いずれも成功可否を返すだけで `sys.exit()` は `cli.py` が行う。
5. **閾値の解決規則を「`None` = 既定値」に統一**。タイトル個別の閾値(`end_template_mad_threshold` / `stutter_dup_fraction_threshold` / `fps_runaway_hz_threshold`)は、旧 `cfg.get(key, GLOBAL)` と同じ結果になるよう、`None` のときだけ各モジュールの既定値で解決する。

### 挙動が変わった点(意図的、2件のみ)

- `--help` が例外で落ちていたのを修正した。`--muxed-audio` のヘルプ文に含まれる `85%超` が argparse の `%` 書式として解釈され `ValueError: unsupported format character` になっていた(旧実装から存在したバグ。`85%%超` にエスケープ)。
- `end_template` 未設定・未検出時の警告ログを出す位置が、関数先頭からウィンドウ確定後(`_build_detection`)へ移った。ゲーム起動に失敗した試行ではこの警告が出なくなる。

## 検証

### 1. タイトル設定の全フィールド突き合わせ

旧ファイルを `importlib` で読み込み、新 `GameConfig` の全フィールドと比較した(導出値・既定値も旧 `cfg.get(key, default)` と同じ結果になるかを確認):

```bash
python3 - <<'PY'
import importlib.util, sys, dataclasses
sys.path.insert(0, '.')
spec = importlib.util.spec_from_file_location("rec25", "scripts/25_record_replay_e2e_multigame.py")
old = importlib.util.module_from_spec(spec); spec.loader.exec_module(old)
from recorder.games import GAME_CONFIGS as NEW
# ... 全12タイトル・全フィールドを比較 ...
PY
```

結果: **ALL MATCH**(タイトルの定義順も一致。旧キーの移植漏れもなし)。

### 2. ffmpegコマンドの一致確認

`build_video_ffmpeg_cmd()` が旧実装と同じ引数列を生成することを、以下3パターンで確認した:

- 音声分離(既定)・フィルタなし → `ffmpeg -y -copyts -f x11grab -draw_mouse 0 -video_size 640x480 -framerate 60 -i :97+0,0 -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p <base>.video.mp4`
- `poll_side_stream` + ウォーターマーク + 720pアップスケール(th06nc相当) → `split=2` → `fps=8,scale=160:120,format=gray` のサブ出力と `overlay` → `scale=...:720` の連結、末尾に `-map [vpollout] -f rawvideo -pix_fmt gray -flush_packets 1 <base>.pollraw`
- `--muxed-audio`(旧来方式) → pulse入力が `-i` の2番目に入り、ウォーターマークの入力インデックスが `[2:v]` へずれる

### 3. 短尺録画のA/B比較(実機)

同一マシン・同一リプレイ(th07 / `th7_07.rpy`)で新旧を交互に実行した:

```bash
python3 scripts/25_record_replay_e2e_multigame.py --game th07 --replay th7_07.rpy \
  --record-seconds 30 --no-audio \
  --output /mnt/cache3/sattori-th07-verify/phase83_module_refactor/th07_video.mp4
```

| 実行 | 実装 | 総録画 | 重複フレーム率(15..31s) | 出力サイズ |
|---|---|---|---|---|
| 1回目 | 新(`recorder/`) | 35.9s | 28.3% | 13,127,164 B |
| 2回目 | 旧(1ファイル版) | 35.8s | 0.0% | 17,620,345 B |
| 3回目 | 新(`recorder/`) | 35.8s | 0.0% | — |

1回目の28.3%は、その日の最初の実行(WINEPREFIX・ゲームディレクトリがページキャッシュに乗っていない状態)で起きた既知の「録画開始直後の外乱」であり、同じ新実装の3回目は旧実装と同じ0.0%だった。**新旧で録画品質に差はない**と判断した。

なお旧実装との比較は、`REPO` の解決(`os.path.dirname(os.path.dirname(__file__))`)が正しく効くよう、旧ファイルを `scripts/_tmp_old_rec25.py` として一時的に置いて実行した(比較後に削除)。

### 4. フル尺録画(終了検知・mux・チャプター出力)

短尺・`--no-audio` では通らない経路(リプレイ選択画面テンプレート照合による終了検知、映像/音声の別録りとA/V同期補正付きmux、`StageMarker` からのチャプター生成、重複フレーム率による合否判定)を、th07 Extra(`th7_07.rpy`、理論尺846.9秒 = 50,812フレーム)のフル尺録画で確認した。

#### 1本目: タイムアウト(ウィンドウ装飾の混入による既存不具合)

```bash
python3 scripts/25_record_replay_e2e_multigame.py --game th07 --replay th7_07.rpy \
  --output /mnt/cache3/sattori-th07-verify/phase83_module_refactor/th07_full.mp4
```

リプレイ自体は正常に完走した(MODログのScoreMonitorが記録スコア `30376604` に到達、elapsed 826秒)ものの、その後のリプレイ選択画面でテンプレート照合が成立せず(`template_MAD=39.12` が一定、閾値15.0)、`TIMEOUT_SEC`(40分)まで録画が続いた。

原因は**録画にウィンドウ装飾(タイトルバー、高さ約29px)が写り込んでいた**こと。`move_into_screen()` の(0,0)強制移動後に `xwininfo` が `x=0 y=0` を返すのに、実際の描画内容は装飾ぶん右下へずれていた(th09の既知不具合と同じ症状、reports/68)。録画から抽出した終了画面フレームで再計算すると:

| 切り出し | テンプレートMAD | 判定(閾値15.0) |
|---|---|---|
| 録画そのまま(装飾込み) | 38.92 | 不一致 |
| 装飾(3, 29)ぶんをずらして切り出し | 12.75 | 一致 |
| 同 (4, 30) | 11.65 | 一致 |

**この症状は旧`scripts/25`の1ファイル実装でも同一**であることを、A/B比較で録った旧実装の録画フレーム(`old_frame20.png`、同じくタイトルバーが写り込んでいる)で確認した。モジュール分割による回帰ではないため、本フェーズでは既定値を変えず `docs/known-limitations.md` に記録した。

#### 2本目: ゲーム本体のクラッシュ(処理落ち早期検知が正しく発火)

装飾ずれを避けるため `skip_origin_move_if_fits=True` をoverrideして再実行したところ、Wine上で `th07.exe` がリプレイロード中にクラッシュし(「プログラム エラー」ダイアログ)、画面が完全静止した。stutter probeが `dup_fraction=1.00` で発火して試行を破棄した(この実行は `max_attempts=1` だったためそこで終了)。**処理落ち早期検知と分類・破棄の経路が期待どおり動くことが実証された**形になった。

#### 3本目: 正常完了

同じ設定で `max_attempts=3`(既定)にして再実行し、1回目の試行で正常終了した。`recorder` をライブラリとして呼ぶ形で実行している(モジュール化後のAPIの実地確認も兼ねる):

```python
from recorder import RecordingOptions, load_game_config, record_with_retry

config = load_game_config("th07", skip_origin_move_if_fits=True)
options = RecordingOptions(replay="th7_07.rpy",
                           output="/mnt/cache3/sattori-th07-verify/phase83_module_refactor/th07_full2.mp4")
record_with_retry(config, options)
```

結果:

| 項目 | 実測値 |
|---|---|
| 総録画時間 | 839.2秒(理論尺846.9秒、リプレイ完走) |
| 終了検知 | リプレイ選択画面テンプレート照合(`template_MAD=1.50` が2回連続、elapsed 826.3s→828.5s) |
| stutter probe | 19.8s / 84.1s / 148.4s / 212.7s / 277.0s いずれも `dup_fraction=0.00` |
| A/V同期補正 | `video_start=1789592755.900 audio_start=1789592755.856 delta=-0.044s` → 映像側に `-itsoffset 0.044` |
| 出力 | 665,065,276バイト、834.5秒、h264 640x480 + aac(mux済み) |
| 重複フレーム率(15〜45秒) | 0.1% → 合格(閾値30.0%) |
| チャプター | `th07_full2.chapters.txt` / `.chapters.json` を出力 |

チャプターは `00:04 1面` / `00:04 2面` の2件(内部ステージID 6→7 の遷移を出現順で連番にしたもの)。Extraステージのリプレイでは内部IDの遷移が2回起きるためこうなるが、これは旧実装と同一のロジックであり本フェーズでの変更点ではない。

以上で、**テンプレート照合による終了検知・映像/音声の別録りとA/V同期補正付きmux・チャプター生成・重複フレーム率による合否判定・処理落ち早期検知による破棄**の全経路が、モジュール分割後も期待どおり動くことを実機で確認した。

### 5. 静的チェック

`python3 -m pyflakes recorder/*.py scripts/25_record_replay_e2e_multigame.py scripts/49_stage_probe_run.py` → 指摘なし。

## 呼び出し側の更新

- `scripts/25_record_replay_e2e_multigame.py`: 互換シム化(27行)。`sys.path` にリポジトリルートを足して `recorder.cli.main()` を呼ぶだけ。
- `scripts/49_stage_probe_run.py`: 旧ファイルを `importlib` で読み込んで `rec25.*` を使っていたのを、`recorder` パッケージの直接importに変更。
- Dockerfile 11本(`cloud/docker/Dockerfile`, `cloud/docker/aws/Dockerfile*`): `COPY scripts/ /app/scripts/` の直後に `COPY recorder/ /app/recorder/` を追加。シムが `/app` を `sys.path` に足すため、`entrypoint_multigame.py` 側の変更は不要。
- `.dockerignore`: `__pycache__/` を除外に追加。
- MODソースのコメント(`mods/common/stage_marker_hook.h`, `mods/th06c_replay_autoplay/dllmain.cpp`, `mods/th06nc_replay_autoplay/dllmain.cpp`, `mods/th10_replay_autoplay/dllmain.cpp`): 参照先を `scripts/25_...` から `recorder/chapters.py`・`recorder/modlog.py`・`recorder/games.py` へ更新。
- `AGENTS.md`: 「録画には `recorder/` パッケージを使う」を大原則に追加、パイプライン本体の改修先が `scripts/` ではないことを明記。
- `docs/recording-pipeline.md`: 冒頭にモジュール構成表とライブラリとしての使用例を追加。

## 今後この仕組みを使うとき

```python
from recorder import RecordingOptions, load_game_config, record_with_retry

config = load_game_config("th10")                      # recorder/games.py のレジストリから取得
options = RecordingOptions(replay="th10_07.rpy",
                           output="/mnt/cache3/sattori-th10-verify/video.mp4")
record_with_retry(config, options)
```

一時的に閾値や表示番号を変えたい場合は `load_game_config("th10", display=":50", stutter_dup_fraction_threshold=0.9)` のようにoverrideできる(`dataclasses.replace`)。新規タイトルは `recorder/games.py` に `GameConfig(...)` を1件追加する。

## 残課題

- **th07のウィンドウ装飾混入(本フェーズで発見)**: ローカル開発機のth07で、(0,0)強制移動後の録画に装飾が写り込み終了検知が成立しない。旧実装からある症状で、`skip_origin_move_if_fits=True` で回避できることは確認済みだが、AWS実機を含む他環境への影響が未確認のため既定値は変更していない。詳細は `docs/known-limitations.md`。

## 変更ファイル

- 新規: `recorder/`(17ファイル、2,714行)
- 変更: `scripts/25_record_replay_e2e_multigame.py`(シム化)、`scripts/49_stage_probe_run.py`、Dockerfile 11本、`.dockerignore`、`AGENTS.md`、`docs/recording-pipeline.md`、MODソースのコメント4件
