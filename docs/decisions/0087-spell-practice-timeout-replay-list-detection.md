# 0087. スペルプラクティスの耐久時間切れは、リプレイ一覧画面のテンプレート照合を2本目の終了条件にして検知する

- **状態**: 有効
- **決定日**: 2026-11-24
- **対象**: worker
- **関連**: [`docs/reports/2026-11-24-spell-practice-timeout-end-detection.md`](../reports/2026-11-24-spell-practice-timeout-end-detection.md)、[`0011`](0011-replay-end-template-matching.md)

th13・th14・th20のスペルプラクティスで耐久して時間切れになったリプレイは、終了メニューに入らず
リプレイ一覧画面へ戻る。一覧画面は背景が全面で動き続けるため画面静止検知が成立せず、本番では
実時間の上限(120分)まで録り続けた。

## 決定

- フレーム同期の監視(`framesync._monitor_until_end`)に、**一覧画面のテンプレート照合を2本目の終了条件**として足す。
  2回連続で一致したら`detected_by="replay_list"`で終了し、`content_end_sec`は一致の始まりにする。
- 有効化は`GameConfig.replay_list_detect`(th13・th14・th20のみ)。テンプレートは
  `assets/replay_end_templates/{game_id}_replay_list.png`、一覧の先頭行(プレイヤー名・日付)を
  `replay_list_exclude_rows`で除く。閾値は既定15、th20だけ35。
- **既存の`end_template`は流用しない**。あちらは「テンプレートがあれば画面静止を使わない」排他の作りで、
  th13等に置くと正常終了(終了メニューの静止)を取りこぼす。

## 採らなかった選択肢

- 画面静止の除外矩形・閾値の緩和: 一覧画面は全面が動く(th20はMADが30近く)ため不可。緩めればプレイ中に誤検知する。
- 理論尺(frameCount)による打ち切り: 保険として有効だが、打ち切った動画の扱い(警告付き配信か失敗か)を別に決める
  必要があるため、今回は見送った。

## 未了

- 実時間の経路(`pipeline._monitor_until_end`、GPUの段)には足していない。同じ問題があるはずだが別途検証が要る。
- 本番イメージでの実機検証(耐久の3本で終了、他6本と通常の全編録画で退行なし)。
