# 0036. th10「バグマリ」修正の要否は利用者の自己申告に頼る（自動判別しない）

- **状態**: 有効
- **決定日**: 2026-08-29
- **対象**: worker / packages/shared / apps/api / apps/web
- **関連**: Issue #75、touhou-recorder reports/56〜60、
  `docs/reports/2026-08-29-th10-local-recording-verification.md`

th10（東方風神録）録画対応の一部として、既知バグ「バグマリ」の修正可否をVsyncPatchで
制御する必要がある。この設定はリプレイファイルに記録されないため、録画側では記録時の
設定を自動判別できない。本決定は、この不確実性をどう扱うかについてのもの。

## 背景

東方風神録には「バグマリ」——魔理沙Bのショット火力パワーが3.00〜3.95の間にあるとき
火力が異常上昇する——という既知バグがある。有志の拡張パッチ VsyncPatch はこれを修正する
オプション（`vpatch.ini`の`BugFixTh10Power3`）を持つ。touhou-recorder での実機検証
（reports/58）で、**記録リプレイと異なる設定で再生するとリプレイずれ（デシンク）が起きる**
ことを4パターン全て（パッチ有効/無効 × 記録時パッチ有効/無効のリプレイ）で確認した。

問題は、この設定情報が `.rpy` リプレイファイル自体には一切含まれないことである
（VsyncPatch独自の外部設定のため）。したがって、アップロードされたリプレイがどちらの
設定で記録されたかを、サーバー側では判別する手段がない。

## 決定

**判別を諦め、利用者の自己申告に委ねる。** ページAの詳細設定に
`th10BugfixMarisaB`オプション（`RecordingOptions.th10BugfixMarisaB`、既定`false`）を追加し、
録画時に`record_th10.py`が申告どおり`vpatch.ini`の`BugFixTh10Power3`を書き換える
（`recording_common.apply_vpatch_ini_overrides()`、`worker/docs/titles/th10.md`）。

このオプションは「バグの発生条件（魔理沙Bのショット火力パワー3依存）を満たすリプレイ」
でしか意味を持たないため、**「th10かつ魔理沙B」の組み合わせでなければUIをグレーアウトし、
`POST /magic-links`もサーバー側の再パース結果（`replayInfo.character`、クライアント申告では
ない）で判定して握り潰す**（`supportsTh10BugfixMarisaB()`、`apps/api/src/handlers/
requestMagicLink.ts`、Issue #101のslowMotionと同型の「タイトル非対応はサーバー側で握り潰す」
パターンを踏襲）。

既定は`false`（パッチ無効=バグ挙動を再現）にする。VsyncPatch自体が公式パッチではなく
利用者が能動的に導入するものであり、大半の魔理沙Bリプレイは未修正のまま記録されている
と見込まれるため。

## 根拠

- リプレイずれの実機確認: touhou-recorder reports/58（4パターン全て期待通りの結果）。
- サーバー側でのバイナリ判別が原理的に不可能なこと自体は自明だが、念のため
  `@sattori/touhou-replay-parser`のth10デコーダ（`packages/replay-parser/src/games/
  th10.ts`）の出力にVsyncPatch関連のフィールドが存在しないことを確認済み。

## 採らなかった選択肢

- **両設定で録画を試行し、スコア完全一致（`desyncDetected`）で当たりを選ぶ**: 録画コストが
  倍になる（1ジョブ=1回のEC2/自宅ワーカー起動という前提を崩す）うえ、`desyncDetected`判定
  自体もRVA直読みで信頼性が高くない（`JobRecord.desyncDetected`のコメント参照）ため、
  「2回録画して当てずっぽうで選ぶ」の方が「1回申告してもらう」より優れているとは言えない。
- **常にパッチ無効（申告オプションを設けない）**: バグマリ修正パッチを導入していた利用者の
  リプレイが確実にデシンクする。オプションで救える層を最初から切り捨てることになる。
- **常にパッチ有効**: 大半を占めるであろう「パッチ未導入」の利用者側が確実にデシンクする。
  既定値の選び方としてより悪い。

## 影響範囲

- `packages/shared/src/job.ts`（`RecordingOptions.th10BugfixMarisaB`）・
  `packages/shared/src/th10BugfixMarisaB.ts`（`supportsTh10BugfixMarisaB()`）
- `apps/api/src/handlers/requestMagicLink.ts`（サーバー側の握り潰し）・
  `apps/api/src/workerEnv.ts`（`TH10_BUGFIX_MARISA_B`環境変数への転記）
- `apps/web/src/components/UploadForm.tsx`（グレーアウトUI）
- `worker/record_th10.py`・`worker/recording_common.py`
  （`GameConfig.vpatch_ini_overrides`・`apply_vpatch_ini_overrides()`）
- 他タイトルへVsyncPatchの類似オプションを追加する場合、同じ「リプレイに含まれない外部
  設定は自己申告＋サーバー側の握り潰しパターンを踏襲する」判断がそのまま使える。
