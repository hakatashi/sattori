# 0043. fps暴走検知を削除する

- **状態**: 有効
- **決定日**: 2026-09-08
- **対象**: worker
- **関連**: Issue #233、reports/22・23(touhou-recorder、導入時の根拠)、[`0038`](0038-remove-stutter-early-detection.md)（同型の先例）

`worker/recording/modlog.py`の`scan_fps_runaway()`と、`pipeline.py`側でこれを使う早期
終了・リトライ分岐を削除する。実際に本番で発火した事例が2件とも偽陽性で、真陽性の実績が
一度も無いまま、正常なリプレイを誤って失敗させ続けるリスクだけを抱えていたため。

## 背景

fps暴走検知は th08 対応（Issue #13、touhou-recorder reports/22）で導入された。ver1.00a の
th08 は内部fpsが数百〜数千に暴走しリプレイが実時間の数十分の一で終わる既知の不具合を
抱えており、MOD(`mods/common/fps_monitor.cpp`)がGetDeviceStateフックの呼び出し頻度を
5秒毎にログ出力し、`scan_fps_runaway()`が閾値超過の継続を検知したら録画を破棄・リトライ
する仕組みだった。ゲームデータを公式アップデータ ver1.00d へ更新したことで根本原因は
事実上解消したが（成功率20%→100%、reports/23）、検知ロジック自体は「稀な残存ケースへの
備え」として残していた。

この判断は運用中に2度、誤りだったことが判明している。

1. **2026-07-29(commit 52bd86d)**: th08の会話イベント（ダイアログボックス表示中）で、
   実際のレンダリングfpsは60のままGetDeviceStateのポーリング頻度だけが良性に約3倍
   （実測179.9Hz）へ跳ね上がる仕様が判明した。旧閾値100Hzはこれを誤って異常判定して
   いたため、良性上昇の実測上限(179.9Hz)と本物のfps暴走の実測下限(479Hz、reports/22)の
   中間である300Hzへ引き上げた（ジョブ`64367b3c-64f5-47c4-be9d-e0c4aa8a35d8`の調査に
   基づく）。
2. **2026-09-08(本件、Issue #233)**: th09のStoryリプレイで、ジョブ
   `18a776c8-9098-45a4-b7fc-8e1d66efbd3f`が9回全ての試行（Step Functionsの3リトライ×
   ワーカー内3サブ試行）で失敗した。原因はステージ2開始直後の「決闘開始！」演出付近
   （録画開始から約130秒、毎回ほぼ同じタイミング）で発生するfps暴走誤検知(369.5〜
   375.4Hz)だった。このマシン(自宅ワーカー機、`sattori-home-worker`停止済みの状態で
   検証)で同一リプレイ・同一ワーカーイメージによりローカル再現を3回行い、いずれも
   ほぼ同一のタイミング・Hz値(370.6〜379.9Hz)で再現することを確認した。ユーザーが
   実際の録画映像(診断スナップショット含む)を確認したところ、画面上の実速度・fps表示
   (59.88〜60.00fps)は正常で、リプレイは正しく再生されていた。300Hzへの引き上げでも
   なお良性の上昇を弾けなかったことになる。

CloudWatch Logs(保持14日)で追える範囲では、本番でこの検知が実際に発火した記録は上記
2件(の周辺)のみで、**真陽性(実際にfps暴走が起きていた例)は一度も無い**。

## 決定

`recording/modlog.py`から`FPS_MONITOR_HZ_RE`・`FPS_RUNAWAY_HZ_THRESHOLD`・
`FPS_RUNAWAY_CONSECUTIVE_REQUIRED`・`scan_fps_runaway()`を削除する。`pipeline.py`側は
`_monitor_until_end()`の`scan_fps_runaway()`呼び出しと早期終了分岐、`fps_runaway_hz`の
追跡・戻り値、`attempt_recording()`の`classification == "fps_runaway"`分岐、
`_record_with_retry()`の対応するリトライ分岐をすべて削除する。`_monitor_until_end()`の
戻り値は`(detected, frozen, fps_runaway_hz, last_color_frame)`から
`(detected, frozen, last_color_frame)`の3要素へ変わる。

MOD側の`mods/common/fps_monitor.cpp`(GetDeviceState呼び出し頻度を5秒毎にログ出力する
スレッド)は削除しない。ログ出力自体は無害で、将来の調査(デシンクの追加証跡等)に使える
可能性があるため、DLLの再ビルドを要する変更は避け、Python側の判定・リトライ経路だけを
外す。

## 根拠

- **真陽性の実績が無い**: 運用開始以来、fps暴走検知が実際のfps暴走を捉えた例は0件。
  唯一の根拠(reports/22の479〜2700Hz)は本番投入前のver1.00a検証であり、ver1.00d更新で
  解消済みの過去の問題である。
- **偽陽性のリスクは正常なリプレイにも及び、閾値調整では解決しない**: 良性のポーリング
  頻度上昇は「会話イベント」(th08、179.9Hz)と「ステージ間演出」(th09、369〜380Hz)の
  少なくとも2系統確認されており、後者は前回引き上げた300Hz閾値さえ超える。両者を
  確実に分離できる閾値が存在する保証が無く、[`decisions/0038`](0038-remove-stutter-early-detection.md)で
  stutter probeを削除した際と同じ構造的な限界に達している。
- **代替の安全網が別に存在する**: 本物のfps暴走(内部fpsが暴走しリプレイが極端に短時間で
  終わる)が起きた場合でも、録画成功後の重複フレーム率チェック
  (`measure_duplicate_rate()`)やリプレイずれ事後検証(`check_replay_desync()`、対応
  タイトルのみ)、タイムアウト打ち切り検知(Issue #161)が別経路でカバーする。fps暴走
  検知はこれらと重複する安全網だった。

## 採らなかった選択肢

- **閾値をさらに引き上げる(例: 500Hz)**: 良性の上昇がどこまで達するかはタイトル・
  演出内容に依存し、確実に安全な上限が存在する保証が無い。閾値調整は前回(100→300Hz)も
  今回同じ理由で破られており、対症療法に過ぎない。
- **タイトルごとに閾値を変える**: 実装は可能だが、良性上昇の原因(入力ポーリングの
  仕様)がMOD・タイトルごとに違う以上、値を決める実機検証コストが際限なく積み上がる。
  検知ロジック自体を無くせばこのコストは発生しない。
- **MOD側の`fps_monitor.cpp`ごと削除する**: ログ出力自体は無害で、6タイトル分の
  DLL再ビルド・実機検証コストに見合わない。将来の診断用途に残す。

## 影響範囲

- `worker/recording/modlog.py`(`FPS_MONITOR_HZ_RE`・`FPS_RUNAWAY_HZ_THRESHOLD`・
  `FPS_RUNAWAY_CONSECUTIVE_REQUIRED`・`scan_fps_runaway()`)
- `worker/recording/pipeline.py`(`_monitor_until_end()`の戻り値・`attempt_recording()`・
  `_record_with_retry()`)
- `worker/recording/__init__.py`・`worker/README.md`・`worker/docs/recording-package.md`・
  `worker/docs/mods.md`・`worker/docs/titles/th06.md`・`th08.md`・`th09.md`・`th10.md`・
  `th11.md`・`th12.md`・`docs/runbooks/worker-local-recording.md`のfps暴走関連の記述
- `worker/tests/test_recording_modlog.py`・`worker/tests/test_recording_pipeline.py`
