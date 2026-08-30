# `recording/` パッケージ分割後の録画パイプライン実機検証（Issue #201・#188）

- **検証日**: 2026-08-31
- **対象**: `worker/recording_common.py` を `worker/recording/` パッケージへ分割し、
  `record_thNN.py` をシム化したリファクタリング（[`decisions/0041`](../decisions/0041-worker-recording-package-split.md)）。
  th10（テンプレート照合経路）と th20 低速録画（画面静止のみ経路 + thprac + `time_scale`）
- **環境**: 自宅マシン（HakataMatrix）でのローカル実行。Docker 経由ではなくホスト上で直接実行
- **結論**: th10 は初回試行でフル尺録画・終了検知・スコア完全一致まで成功。th20 も低速録画の
  スケーリング・thprac アタッチ・画面外ウィンドウの移動まで分割前と同じ挙動を確認した

**このリファクタリングは振る舞いを変えないことが前提**（`AGENTS.md` §3「録画パイプラインの
変更は必ず実機検証を経ること」）。ユニットテスト232件とログ文字列の集合比較に加えて、
実機で2タイトル・2つの終了検知経路を通した記録がこれ。

## 目的

分割は機械的な移動だが、以下は静的な検査では担保できないため実機で確認する。

1. `attempt_recording()` を4関数へ切り出した際に、処理順・後片付け・戻り値が崩れていないか
2. `GameConfig.for_game()` が組み立てるパスが実在の資産を正しく指すか
3. `end_template_path` の起点を `__file__` から `WORKER_ROOT` へ直した箇所が正しいか
   （**間違えても例外は出ず、画面静止のみ判定へ静かにフォールバックする**）
4. `_monitor_until_end()` の中で `time_scale` 倍するようにした時間定数が、低速録画で
   分割前と同じ値になるか

## 方法

```bash
cd worker

# th10: テンプレート照合による終了検知・mux・重複フレーム率・スコア照合まで通す
timeout --kill-after=30s 1800s python3 record_th10.py \
  --replay-path games/th10/replay/th10_03.rpy --output /tmp/refactor-th10/out.mp4 \
  --progress-dir /tmp/refactor-th10/progress --expected-score 203442620 \
  --desync-result-path /tmp/refactor-th10/desync.json \
  --timeout-result-path /tmp/refactor-th10/timeout.json

# th20: 低速録画。画面静止のみ判定・thprac・%APPDATA%配置・1400x1100のXvfb
FPS_LIMIT_TARGET_HZ=30 timeout --kill-after=30s 600s python3 record_th20.py \
  --replay-path games/th20/replay/th20_03.rpy --output /tmp/refactor-th20/out.mp4 \
  --progress-dir /tmp/refactor-th20/progress --expected-score 241993370 --max-attempts 1
```

リプレイは `th10_03.rpy`（Extra Stage Clear、記録スコア 203,442,620）と
`th20_03.rpy`（Lunatic 1〜5面、記録スコア 241,993,370）。外側の `timeout` ラッパーは
`worker/README.md` §11 の指示に従って付けた。

## 結果

### th10（東方風神録、等倍、テンプレート照合）

| 項目 | 結果 |
| --- | --- |
| 試行回数 | 1回目で成功（リトライなし） |
| 終了検知 | リプレイ選択画面テンプレートと連続一致（録画開始から 13分49秒） |
| 総録画時間 | 829.9秒（出力 mp4 の尺 828.88秒） |
| 重複フレーム率 | 0.0%（閾値30.0%、`time_scale=1.0`） |
| A/V同期補正 | `delta=-0.034s` → `video_offset=0.034s`（`-copyts` の実測差分） |
| スコア照合 | 記録スコア 203,442,620 と一致するサンプルを確認（`desyncDetected: false`） |
| タイムアウト打ち切り | `timedOut: false` |
| 出力 | `/tmp/refactor-th10/out.mp4` 708,603,150 バイト |
| 後片付け | `wineserver` / `th10.exe` の残存なし |
| 終了コード | 0 |

`vpatch.ini` の `BugFixTh10Power3 = 0` 上書き（`vpatch_ini_overrides`）、`extra_dlls` による
`vpatch_th10.dll` の先行注入、進捗スクリーンショットの書き出し（60.0fps 表示のゲーム画面）も
いずれも分割前と同じ動作だった。

### th20（東方錦上京、低速録画 30Hz、画面静止のみ判定）

| 項目 | 結果 |
| --- | --- |
| 低速録画の検出 | `time_scale=2.00`（`FPS_LIMIT_TARGET_HZ=30`） |
| 終了検知の経路 | `assets/replay_end_templates/th20.png` 不在を検知し画面静止のみ判定へフォールバック |
| Xvfb | `:95` を `1400x1100x24` で起動 |
| `%APPDATA%` 配置 | `prefixes/th20-wined3d-gl/drive_c/users/hakatashi/AppData/Roaming/ShanghaiAlice/th20` へ cfg/リプレイを配置 |
| thprac | アタッチ成功（試行1回目、0.7秒、pid一致を `/proc/<pid>/maps` で確認） |
| クロップ座標 | 検出時 `(1065,677) 1280x960` が画面外 → `(0,0)` へ移動して確定 |
| 猶予時間のスケーリング | `監視開始(猶予30.0秒)`（等倍の15.0秒 × 2.0） |
| MOD の実効fps | `FpsMonitor` が 30.0 Hz で安定（fps_limiter_hook が効いている） |
| 終了検知のポーリング | 画面静止ブランチが毎回実行（`MAD=13.36 still=0` 等、23回ぶん確認） |
| 進捗のコンテンツ秒数換算 | 実時間 72.3秒 の時点で `state.json` が `elapsedSeconds: 36.14`（= `elapsed / time_scale`） |

進捗スクリーンショットも 1280x960 の Lunatic 面が正常に描画され、画面焼き込みの fps 表示は
`fps_display_hook` によって等倍相当（60fps）へ補正された値が出ていた。8分ほど走らせた時点で
こちらから停止した（下記「考察」参照）。停止は SIGKILL 相当だったため、`pulse.job_sink()` の
後始末が走らずジョブ専用 sink が1つ残った（`pactl unload-module` で破棄）。**正常終了する
経路では th10 の実行で sink の破棄まで確認済み**。

## 考察・既知の限界

- **th20 は最後まで走らせていない**。低速録画のフルクリアは実時間で60分級になるうえ、
  th20 の低速録画には未解決のハング（Issue #179）がある。終了検知の成立 → 停止 → mux →
  重複フレーム率 → スコア照合という後半の経路は th10 で通しており、その部分のコードは
  タイトル非依存で共通（`_monitor_until_end()` の返り値以降は同一パス）。
  th20 側で確認したのは**分割前後で挙動が変わりうる箇所**（低速スケーリング・thprac・
  `%APPDATA%`・画面外ウィンドウ移動・静止判定へのフォールバック）に絞ってある。
- **画面静止判定が「閾値に到達して終了と判定する」瞬間は今回のどちらの実行でも踏んでいない**
  （th10 はテンプレート照合、th20 は途中打ち切り）。この分岐自体はポーリング毎に実行されて
  いるが、成立の遷移は未検証。
- th06/th07/th08/th11 はこの検証マシンにゲームデータ・リプレイを置いていないため未実行。
  ただし `tests/test_record_thNN.py` が6タイトル全ての `GameConfig` 組み立てを検証している。
- ログに出る `検知方式: 画面静止検知` は、**テンプレート照合で終了を検知した場合も同じ文言が
  出る**（`classification == "good"` に対して固定文言）。これは分割前からの表示上の不正確さで、
  今回は「ログ文言を変えない」方針のため手を入れていない。
