# 0086. リプレイずれ検知は、原因が分かった偽陽性だけを狭く許容する

- **状態**: 有効
- **決定日**: 2026-11-24
- **対象**: worker / apps/api / packages/shared
- **関連**: [`docs/reports/2026-11-24-desync-false-positive-investigation.md`](../reports/2026-11-24-desync-false-positive-investigation.md)（§5 の P1〜P3）

`check_replay_desync()`は「MODのスコアのサンプルに、記録スコアとちょうど一致する値が無ければ true」で
判定していたが、本番の true には、目視でずれていないものが多く含まれていた。原因が特定できた
3種類だけを、真陽性を見逃さない範囲で一致とみなすことにした。**許容を広げる前に報告書の§6を読むこと。**

## 決定

- **P1 th08 のMODのスコア欄を `+0x08`（真値）へ変える**（`mods/th08_replay_autoplay/dllmain.cpp`）。
  `+0x00`は表示用の追っかけ値で、記録スコアに届く前にリプレイが終わって構造体が解放されうる。
- **P2 最終ステージのステージ記録のスコアとの一致も認める**。th06 3731b273のように、リプレイ内で
  ヘッダのスコアと最終ステージの記録が食い違うものがある。`ReplayInfo.finalStageScore`
  （`packages/shared/src/replay.ts`、th07のステージ記録の単位換算（×10）はreplay-parser側で済んでいる）→ `EXPECTED_FINAL_STAGE_SCORE`
  （`apps/api/src/workerEnv.ts`）→ `--final-stage-score` → `check_replay_desync(final_stage_score=)`。
- **P3 最大値が記録を下回り、差が記録の0.3%以内なら一致とみなす**（`modlog.DESYNC_SHORTFALL_TOLERANCE`）。
  th07・th11・th13の最終ステージで、ゲーム側の記録・再生の差により再生の最終値が決定的にわずかに低くなる。

## 根拠

前段の41本（偽陽性24・真陽性17）のMODログに当てると、偽陽性の true が17→2本（検証不能3本を除く）に減り、
真陽性17本はすべて true のまま（報告書§5）。th08は実機でも確認した（スペルプラクティス 01d5db9c は記録スコアに
完全一致、e646fd8a は差500で P3 の許容内、真陽性の e20bccc6 は−20.8%で true のまま）。

## 採らなかった選択肢

- **上回る側にも許容を設ける**: 真陽性の th20 cf96dc25（+0.26%）を見逃すため不可。
- **P4（th20のPIV修正つき記録）**: 今回は見送り。MODの変更か、ステージ開始時の上書き量による検証不能（None）化を
  別途検討する（報告書§5 P4）。
- **0.3%より広い許容**: 7本からの当てはめで母集団の分布が不明。真陽性との最小の間隔は−20.8%なので余裕はあるが、
  広げる根拠が無い。

## 影響範囲

`ReplayInfo`の新フィールド`finalStageScore`は任意（導入前のジョブレコードには無く、その場合はヘッダのスコアだけで判定する）。
th08のMODを変えたので、本番へは**タイトル資産（`th08_hook.dll`）の再アップロード**が要る（`upload-title-assets` skill）。
