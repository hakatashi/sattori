# th07のscore_monitor無効化(RVA不一致)を修正し、判定ロジックも頑健化した

- **検証日**: 2026-08-25
- **対象**: [`2026-08-25-score-monitor-desync-verification.md`](2026-08-25-score-monitor-desync-verification.md)で無効化していたth07のスコア監視(`mods/common/score_monitor.*`)を、正しいRVAへ修正して再度実機検証。あわせて`worker/recording_common.check_replay_desync()`の判定ロジックを頑健化
- **環境**: このリポジトリ（開発マシン）上のWine+Xvfbによるローカル録画。`worker/games/th07/`（`ver 1.00b`、touhou-recorder側の`th07_ver100b`と同一バイナリ）を使用
- **結論**: **th07を含む全5タイトルでscore_monitorが実機で正しく動作することを確認した。判定ロジックも、リプレイ終了直後の新種のゴミ値パターンに対して頑健化した**

## 目的

前回の検証（上記リンク）で、Sattoriが配布するth07.exe（`ver 1.00b`）がtouhou-recorder側の
検証環境（`ver 1.00`、公式パッチ未適用）とバイナリが異なり、検証済みRVAが通用せず
th07のスコア監視を無効化していた。ユーザーがtouhou-recorder側で`ver 1.00b`のゲームデータを
入手し再検証した結果（touhou-recorder `reports/54_phase54_th07_ver100b_reverification.md`）、
正しいRVAが判明したため、これをSattori側へ反映し実機で確認する。

## 方法

touhou-recorder reports/54の結論に基づき、`worker/mods/th07_replay_autoplay/dllmain.cpp`の
`ScoreMonitorConfig`を修正した:

- `baseRva`: `0x21c250 + 0x8`（旧バイナリ向けの補正値）→ `0x226270 + 0x8`
  （thprac記載のGAME_MANAGER絶対VA`0x626270`をそのまま使用。ver1.00bについては
  thprac記載の値がそのまま正しく、旧バイナリ向けの補正は不要だった）
- メニュー操作のDown回数（Step 1）はSattori側は元々2回で、touhou-recorder reports/54が
  指摘した「ver1.00bでは2回」と一致していたため変更不要だった

`worker/mods/common/`でmingw-w64ビルドし直し（`build-mods` skill）、実サンプルリプレイ
（th7_07.rpy、touhou-recorderから借用）で短時間録画を行い、MODログにスコアが単調増加で
記録されるかを確認した。

あわせて、touhou-recorder reports/54で判明した「リプレイ終了直後、グレイズは直前と同一の
ままスコアだけ壊れるゴミ値パターン」（既存のグレイズ上限フィルタでは検知できない）に対応するため、
`worker/recording_common.py`の判定ロジックを「MODログの最後の1件を見る」方式から
「記録全体（グレイズによるゴミ値フィルタ後）のどこかに記録スコアとちょうど一致するサンプルが
あるかを探す」方式へ変更した（`read_final_verified_score()` → `read_verified_scores()` +
`check_replay_desync()`の判定変更）。

## 結果

### th07 実機動作確認（短時間録画）

`th7_07.rpy`で約35秒の短時間録画を実施。MODログ（`th07_autoplay.log`）:

```
ScoreMonitor: started (module_base=0x00400000 base_rva=0x00226278 base_is_pointer=1 score_offset=0x00000004 score_width=4 interval=1000ms)
ScoreMonitor: score=20382568 stage=0 lives=-2147483648 graze=-1487693438 epoch_ms=...  # ポインタ確保直後のゴミ値(graze負値、既存フィルタで除外される)
ScoreMonitor: score=0 stage=0 lives=2 graze=0 epoch_ms=...
ScoreMonitor: score=1516 stage=0 lives=2 graze=6 epoch_ms=...
...
ScoreMonitor: score=55452 stage=0 lives=2 graze=246 epoch_ms=...
```

スコアが単調増加することを確認した（touhou-recorder reports/54の実測値「0→55,969」と
同じオーダー・パターン）。既知の「ポインタ確保直後の1回だけのゴミ値」（reports/53）も
グレイズが負値であるため`GRAZE_GARBAGE_MAX`フィルタで正しく除外された。

### 判定ロジックの頑健化（単体テスト）

`worker/tests/test_recording_common.py`に、touhou-recorder reports/54で実測された
新パターンのゴミ値（グレイズ不変・スコアのみ破損）を再現するテストケースを追加し、
「記録スコアと一致するサンプルが記録全体のどこかにあれば一致と判定する」新ロジックが
末尾のゴミ値に引きずられず正しく`False`（一致）を返すことを確認した。既存のテスト
（全5タイトルのゴミ値フィルタ・倍率換算）も含め、全202件がパスすることを確認した。

## 考察・既知の限界

- 今回の短時間録画（約35秒）では「スコアが単調増加する」ことしか確認できておらず、
  touhou-recorder reports/54のような**フル尺録画でのリプレイ記録スコアとの完全一致検証**は
  Sattori側では行っていない（touhou-recorder側でver1.00bのフル尺録画による完全一致は
  実証済み）。
- Issue #168（th07 RVA再特定の追跡課題）はこの修正で解決したためクローズする。
