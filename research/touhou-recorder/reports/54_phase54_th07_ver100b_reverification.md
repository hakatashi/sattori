# フェーズ54: th07のゲームデータ差異(ver1.00b)によるscore_monitor不具合の修正

日付: 2026-08-25

前提: フェーズ53でth06/07/08/11/20全タイトルのscore_monitorを実機検証・報告した後、
sattori側(`../sattori`)が同じ実装を本番ワーカーへ移植したところ、
**th07だけスコアが一切取得できない**現象が発生した
(`../sattori/docs/reports/2026-08-25-score-monitor-desync-verification.md`)。
原因は、sattoriが配布しているth07.exeがフェーズ53の検証に使ったth07.exeと
バイナリレベルで異なっていたため。ユーザーからsattoriと同じ`ver1.00b`の
ゲームデータの提供を受け(`games/th07_ver100b/`)、これを使って再検証した。

## 結論(先に要約)

**th07 ver1.00b向けにMOD(メニュー自動操作・ステージ検出・スコア監視)を
修正し、フル尺録画でリプレイ記録スコアとの完全一致を再実証した。** 以後の
th07検証・本番録画は`games/th07_ver100b/`を使うこと(`scripts/25`の
`GAME_CONFIGS["th07"]`を更新済み)。

判明した差異は3点:

1. **メインメニューの「Replay」到達に必要なDownキー回数が違う**(旧: 3回 →
   ver1.00b: 2回)。ユーザー指摘、sattori側
   `worker/mods/th07_replay_autoplay/dllmain.cpp`で確認済みの値と一致
2. **ステージ番号変数のRVAが違う**(旧: `0x0022583c` → ver1.00b:
   `0x0022f85c`)
3. **スコア監視用GAME_MANAGERのRVAが違う**(フェーズ53では旧バイナリ向けに
   `0x0021c250`へ補正していたが、ver1.00bでは**thprac記載のオリジナルの
   絶対VA`0x626270`(RVA`0x226270`)がそのまま正しい**)

いずれも「フェーズ53で検証した旧th07.exe(607744バイト、公式パッチ未適用)」と
「sattoriが配布しているver1.00b(650752バイト)」がバイナリレベルで別物だった
ことに起因する。**ゲームデータのバージョンが変わればRVAだけでなくメニュー
構造すら変わりうる**という教訓が得られた。

## ゲームデータの確認

```
$ md5sum games/th07/th07.exe games/th07_ver100b/th07.exe
91e964f236e7395e9dae27bae48818bd  games/th07/th07.exe        (607744 bytes, 旧)
0126afce1e805370d36c3482445e98da  games/th07_ver100b/th07.exe (650752 bytes, ver1.00b)
```

`games/th07_ver100b/`にはvpatch.exe/vpatch_th07.dll/youmu_update100b.EXEが
同梱されており、公式パッチ1.00b適用済みのデータであることが分かる
(ただしvpatch_th07.dllの注入はth07では不要、白画面問題が起きるのはth06のみ、
`reports/30_phase30_th06_rendering_fix.md`参照)。`th07.cfg`は旧データと
バイト列が完全一致しており、ウィンドウモード設定は変更不要だった。

`scripts/25_record_replay_e2e_multigame.py`の`GAME_CONFIGS["th07"]`の
`game_dir_src`を`games/th07`から`games/th07_ver100b`に変更した(th08の
`ver100d`移行と同じパターン)。`games/th07_ver100b/replay/`に
`games/th07/replay/`のサンプルリプレイ一式をコピーして配置した。

## 症状の再現と原因調査

`game_dir_src`切り替え後、旧のRVA・メニュー操作シーケンスのままth07を
短時間録画したところ、**メインメニューでDown x3を実行した直後の画面は
「Replay」がハイライトされているように見えたが、そこでEnterを押すと
リプレイ一覧ではなく「History of Score and Spell Card」(スコア履歴)画面に
遷移してしまい、実際にはリプレイが再生されなかった**(録画時間30秒に対し
出力ファイルサイズがわずか1.28MB、重複フレーム率100%)。

この時点でユーザーから、sattori側で既に「Down x2が正しい」と特定済みである
旨の指摘を受けた。`mods/th07_replay_autoplay/dllmain.cpp`の`Step 1`を
Down x3→Down x2に修正したところ、実際にゲームプレイ画面(スコア表示・
弾幕)が録画されるようになった。

## ステージ番号RVA・GAME_MANAGER RVAの再特定

Down x2修正後もStageMarker・ScoreMonitorとも一切出力されなかった
(旧RVAがver1.00bでは無意味なアドレスを指しているため)。フェーズ49・53と
同じ手順で再特定した。

### 手順

1. `scripts/49_stage_probe_run.py --game th07 --replay th7_09.rpy --duration 600`
   でSTAGE_PROBE有効のMODを10分間実行し、差分スキャンログ(40.0 MiB)を取得
   (`runs/th53_verify/th07_v100b_stage_probe.log`)
2. 同じログのIO観測から、thbgm.datのトラック切り替え時刻(ステージ境界の
   目安)を抽出: `t=188.35s`(2面境界)、`t=427.52s`(3面境界)
3. MEM候補(値0〜20・変化回数8回以下)の中から、**この2つの時刻でそれぞれ
   ちょうど+1され、かつ値が連続している**(1→2→3のように)アドレスを
   Pythonスクリプトで絞り込み、10候補まで削減
4. 候補`0x0062f85c`(RVA `0x0022f85c`)が、**thprac側の
   `offsetof(GameManager, stage) == 0x95ec`という構造体レイアウトと、
   GAME_MANAGER絶対VA`0x626270`から計算した予測値
   (`0x626270 + 0x95ec = 0x62f85c`)に1バイトの狂いもなく完全一致**した

この一致は、**ver1.00bについてはthprac記載のGAME_MANAGER絶対VA
(`0x626270`)がそのまま正しい**ことを意味する。フェーズ53で「旧th07.exeでは
thprac記載の値が誤りだった」として`0x0021c250`へ補正した対応は、あくまで
旧バイナリ固有の補正であり、**ver1.00bには適用してはならない**(thpracは
基本的にコミュニティで広く使われる最終パッチ版=ver1.00bをターゲットに
開発されているため、むしろthprac記載の値をそのまま信頼するのが素直な
結論だったことになる)。

### 修正内容

`mods/th07_replay_autoplay/dllmain.cpp`:

- `InstallStageMarkerHook(0x0022583c, ...)` → `InstallStageMarkerHook(0x0022f85c, ...)`
- `ScoreMonitorConfig.baseRva = 0x21c250 + 0x8` → `0x226270 + 0x8`(thprac記載のGAME_MANAGER+globalsフィールドオフセットそのまま)
- `InstallPatternMarkerHook(0x00095bec)`・`InstallSpellFlagMarkerHook(0x005ac82b)`は
  **ver1.00b向けの再特定を行っていない**(スコープ外、旧バイナリ向けの値の
  ままなので恐らく無効。弾幕パターン検出機能を使う場合は同様の手順で
  再調査が必要)

mingw-w64で再ビルドし、`mods/th07_replay_autoplay/build/th07_hook.dll`を更新した。

## 実機動作確認

### 短時間録画(30秒)

`th7_07.rpy`(Extra面クリア)でStageMarker(`stage=6`→`stage=7`、Extra面を
正しく検出)・ScoreMonitor(スコア0→55,969・グレイズ0→246と単調増加)を確認。

### フル尺録画

`scripts/25 --game th07 --replay th7_07.rpy --no-audio --max-attempts 1`
(自然終了まで録画)を実行。旧バイナリと同じ既知課題(リプレイ選択画面の
テンプレート照合不一致、report49既出)により40分タイムアウトで停止したが、
`ScoreMonitor`ログには正しい完走時点の値が記録されていた:

```
[14:52:58.884] ScoreMonitor: score=30376604 stage=0 lives=1 graze=2650 epoch_ms=1787637178884
[14:53:01.887] ScoreMonitor: score=38797976 stage=0 lives=1 graze=2650 epoch_ms=1787637181887
```

`30376604 × 10 = 303,766,040`は`th7_07.rpy`の記録スコアと**完全一致**。
その3秒後、末尾特有のゴミ値(フェーズ53で確認済みのパターン)が1件現れた。

## 新パターンのゴミ値: グレイズ上限フィルタだけでは検知できないケース

フェーズ53の`drop_garbage_samples()`(グレイズが現実的な上限を超える/負に
なるサンプルを除外)を適用したところ、**このゴミ値サンプルはグレイズが
直前と同一(`2650`のまま)だったため検知されなかった**。結果、素朴に
「フィルタ後の最終サンプル」を最終スコアとする実装では、誤って
`387,979,760`(不一致)と判定してしまった。

対策として、`scripts/53_verify_replay_score.py`の一致判定ロジックを
「ログ末尾のサンプルを見る」方式から**「記録全体(ゴミ値フィルタ前)の
どこかに記録スコアと完全一致するサンプルがあるかを探す」方式**に変更した。
スコアは正常なプレイ中は単調非減少で、記録スコアちょうどの値に到達するのは
「そこでリプレイ再生が記録時と同じ結果まで到達した」ことの動かぬ証拠になる
(ゴミ値が偶然ちょうど記録スコアと一致する確率は無視できるほど小さい)ため、
**この後に何が起きようと(=末尾が壊れていようと)一致判定は揺るがない**。
表示用の「再生時スコア」も、一致した場合はその一致サンプルの値を使うように
修正し、判定と表示の整合性を保った。

この修正後、th06/07(新)/08/11/20の既存フル尺録画データ全てで再検証し、
全て引き続き「一致」と判定されることを確認した(リグレッションなし)。

| タイトル | リプレイ | 記録スコア | 判定 |
|---|---|---:|:---:|
| th06 | th6_02.rpy | 66,329,830 | ✅一致 |
| th07 | th7_07.rpy(ver1.00b) | 303,766,040 | ✅一致 |
| th08 | th8_06.rpy | 1,196,970,600 | ✅一致 |
| th11 | th11_03.rpy | 182,237,970 | ✅一致 |
| th20 | th20_01.rpy | 481,237,400 | ✅一致 |

## 教訓・今後の運用

- **ゲームデータのバージョンが異なると、RVAだけでなくメニュー構造(Down回数
  等)まで変わりうる**。新しい配布元のゲームデータを使う際は、MD5/ファイル
  サイズで一致を確認するか、少なくとも短時間録画でメニュー遷移が意図通りに
  進んでいるか(録画ファイルサイズ・重複フレーム率で異常を検知できる)を
  必ず確認すること
- **thprac記載のRVAが「誤り」に見えた場合でも、それが本当に対象バイナリの
  問題なのか、単にゲームデータのバージョンがthpracの対象(通常は最終パッチ版)
  と違うだけなのかを切り分けること**。今回、フェーズ53で「thprac記載の
  値は誤り」と結論づけたのは、実際には検証に使った旧バイナリがthpracの
  対象ver1.00bと違っていただけだった
- **リプレイ再生終了直後のゴミ値パターンは1種類ではない**。グレイズも
  同時に壊れるパターン(フェーズ53で確認)と、グレイズは直前のまま
  スコアだけ壊れるパターン(本フェーズで確認)の両方がある。「記録全体から
  完全一致サンプルを探す」方式にしたことで、今後未知のゴミ値パターンが
  出てきても頑健になった
- th07のパターン/スペルカードマーカー(`InstallPatternMarkerHook`・
  `InstallSpellFlagMarkerHook`)はver1.00b向けに未再特定のまま。使う場合は
  `SCORE_PROBE`/`STAGE_PROBE`と同じ手順(カウンタ反転検出モード、
  `reports/49_phase49_stage_start_timestamp_detection.md`参照)で再調査が必要
- sattori側`worker/mods/th07_replay_autoplay/dllmain.cpp`に本フェーズで
  特定したRVA・Down x2修正を反映すればth07のscore_monitorが有効化できる
  見込み(sattori側での実機確認は別途必要)

## 成果物

- `scripts/25_record_replay_e2e_multigame.py`: `GAME_CONFIGS["th07"]`を
  `games/th07_ver100b`に変更
- `games/th07_ver100b/`: ver1.00bゲームデータ配置(ユーザー提供)、
  `replay/`にサンプルリプレイ一式をコピー
- `mods/th07_replay_autoplay/dllmain.cpp`: Down x2修正、ステージ番号RVA・
  GAME_MANAGER RVAをver1.00b向けに修正
- `mods/th07_replay_autoplay/build/th07_hook.dll`: 再ビルド(mingw-w64)
- `scripts/53_verify_replay_score.py`: 一致判定を「末尾サンプル」から
  「記録全体からの完全一致探索」に変更、末尾ゴミ値の影響を受けない設計に
- `runs/th53_verify/th07_v100b_stage_probe.log`・
  `runs/th53_verify/th07_v100b_full.mp4`等: 検証データ一式
