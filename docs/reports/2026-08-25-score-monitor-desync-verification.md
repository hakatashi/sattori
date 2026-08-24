# score_monitor(リプレイずれ検証、Issue #103)の5タイトル横展開を実機検証

- **検証日**: 2026-08-25
- **対象**: `mods/common/score_monitor.*`（touhou-recorder reports/53からの移植）を
  th06・th07・th08・th11・th20の5タイトルへ横展開し、短時間録画でMODログに
  ゲーム内スコアが正しく出力されるかを確認
- **環境**: このリポジトリ（開発マシン）上のWine+Xvfbによるローカル録画。
  `worker/games/{title}/` に配置済みの本番同等ゲームデータを使用
- **結論**: **th06・th08・th11・th20の4タイトルは実機で動作確認できた
  （スコアが単調増加）。th07だけは、Sattoriが配布しているth07.exeが
  touhou-recorderの検証環境とバイナリレベルで異なるため、既知のRVAでは
  スコアを取得できないことが判明し、th07のMODでは無効化した**

## 目的

touhou-recorder側でth20限定だったMODのスコア監視（reports/50）を、フェーズ53で
全5タイトルへ横展開・実機検証済みという報告を受け、同じ実装をSattori本番の
`worker/mods/`へ移植したうえで、**Sattori自身が配布しているゲームバイナリ**でも
同じRVAが通用するかを確認する。

## 方法

`worker/mods/common/score_monitor.{h,cpp}`をtouhou-recorder側の汎用版（`baseRva`+
`baseIsPointer`+フィールドごとのオフセット/幅）へ更新し、各タイトルの`dllmain.cpp`に
touhou-recorder reports/53記載のRVAで`ScoreMonitorConfig`を組み込んだ。

各タイトルについて、`worker/mods/`をmingw-w64でビルドし直し（`build-mods` skill）、
実サンプルリプレイ（touhou-recorderの`games/{title}/replay/`から借用、th06:
th6_02.rpy、th07: th7_07.rpy、th08: th8_01.rpy、th11: th11_03.rpy、th20:
th20_01.rpy）で25〜90秒の短時間録画を行い、MODログ（`{title}_autoplay.log`）に
`ScoreMonitor: score=... stage=... lives=... graze=... epoch_ms=...`が出力され、
スコアが単調増加するかを確認した（`worker/record_{title}.py`をローカルから直接
実行、S3/DynamoDBなしのスタンドアロン実行）。

## 結果

| タイトル | ゲームバイナリの一致 | 結果 |
| --- | --- | --- |
| th06 | (touhou-recorderに東方紅魔郷の同一比較対象なし、RVA自体は直接検証) | ✅ スコア単調増加を確認 |
| th07 | **不一致**: Sattori `ver 1.00b`(650752バイト) / touhou-recorder `ver 1.00`(607744バイト) | ❌ `GAME_MANAGER->globals`が常に0のまま、スコア取得不可 |
| th08 | 一致: 両者とも`ver 1.00d`（MD5 `77b6785e...`で完全一致） | ✅ スコア単調増加を確認（ポインタ確保直後のゴミ値サンプルも報告どおり再現） |
| th11 | 一致: MD5完全一致（688128バイト、2008-08-03） | ✅ スコア単調増加を確認、`stage=1`到達も確認 |
| th20 | (未比較、既存の実装をフィールド名リファクタしたのみ) | ✅ スコア単調増加を確認（既存のリグレッション無し） |

th07については、`worker/mods/common/score_probe_hook.*`・`stage_probe_hook.*`
（touhou-recorder reports/53・49からの移植、診断専用）でSattoriのth07.exeを対象に
再度RVAを特定しようと試みたが、以下の理由で本調査の範囲では特定できなかった:

- `score_probe_hook`（イメージ内のRVA範囲を「単調非減少」条件でスキャン）は、
  スキャン範囲を0x0〜0x300000・0x400000で試したがいずれも候補上限200件で
  打ち切られるほどノイズが多く、単一の有力候補に絞り込めなかった。
- `stage_probe_hook`（書き込み可能領域全体のバイト単位差分スキャン、
  「値が+1されつつ変化回数が少ない」条件）も、タイトル画面のメニュー操作
  演出や弾幕関連のカウンタが同条件を大量に満たしてしまい、warmup期間の
  調整だけでは実用的な絞り込みに至らなかった。

## 考察・既知の限界

- **th07のRVA再特定は今回のスコープ外とした**。touhou-recorder側でも当初の
  RVAが誤りだったため、実測済みのステージマーカーRVAから逆算する2段階の
  調査を要した（reports/49・53）。Sattoriの`ver 1.00b`向けに同水準の調査を
  行うには、フル尺録画・複数ステージにまたがる差分スキャンなど、この検証
  よりも大きな時間を要すると判断し、Issue #168として追跡課題化した
  （`worker/mods/th07_replay_autoplay/dllmain.cpp`にもコメントで詳細を残してある）。
- 診断専用コード(`score_probe_hook.*`・`stage_probe_hook.*`)は
  `worker/mods/common/`に残置してある（`build-mods` skillの本番ビルドコマンドには
  含めない）。th07のRVA調査を再開する際、あるいは他タイトルで同種のバージョン差
  問題が疑われた場合に再利用できる。
- 今回の短時間録画（25〜90秒）では「スコアが単調増加する」ことしか確認できて
  おらず、touhou-recorder reports/53のような**フル尺録画でのリプレイ記録スコア
  との完全一致検証**は行っていない（th06/th08/th11/th20とも）。オフセット・倍率の
  誤りは短時間録画では見抜けないことがある（th08の倍率誤りがまさにこのケース、
  touhou-recorder reports/53参照）ため、本番投入後に実ジョブの
  `desyncDetected`が不自然に多発しないか経過観察すること。
