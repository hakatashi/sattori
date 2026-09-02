# th09（東方花映塚）録画対応：sattori本体コードでのローカル実機検証

- **検証日**: 2026-09-02
- **対象**: th09（東方花映塚）録画対応（Issue #73）。`worker/record_th09.py`・
  `worker/mods/th09_replay_autoplay/dllmain.cpp`・`worker/mods/common/score_monitor.*`の
  `scoreWidth=0`対応・`worker/mods/common/fps_display_hook.*`の汎用化・
  `worker/mods/common/fps_limiter_hook_d3d8.*`の新規追加
- **環境**: ローカル開発機（HakataMatrix）、Wine + Xvfb + ffmpeg。ゲーム本体・WINEPREFIX・
  MODビルド成果物はtouhou-recorderの検証済みアセットをそのまま流用（reports/68・69）。
  検証開始前に自宅ワーカー（`sattori-home-worker.service`）を停止し、検証後に再開した
- **結論**: sattori本体の録画パイプライン（touhou-recorderのPoCスクリプトではなく
  `worker/record_th09.py`）でth09のMatch/Storyモード双方のフル尺録画・終了検知・
  残機（life）監視のいずれも実機で成功を確認した。

touhou-recorderでのタイトル対応検証（reports/68〜69）を踏まえて実装したth09録画対応を、
sattoriリポジトリ自身のコードで再検証したもの。

## 目的

Issue #73の実装（MOD移植・`record_th09.py`・`mods/common/`の汎用化）が、touhou-recorderの
PoCスクリプトではなくsattori本体のコードで実際に動作することを確認する。

## 発見・修正した不具合: リプレイファイル名の接頭辞誤り

初回検証で、`record_th09.py`の`canonical_slot="th09_ud0000.rpy"`（実行ファイル名`th09.exe`
から類推した接頭辞）を配置してもゲーム側がユーザーリプレイとして一切認識せず、リプレイ
一覧が全スロット空欄のまま「Enter」を送っても何も再生されない状態になった（メニュー
操作自体は成功ログが出るため、`th12.md`が警告する「誤った経路でも起動エラーにならない」
と同種の気づきにくい失敗だった）。

ゲームデータに同梱されている既存リプレイ（`th9_01.rpy`〜`th9_24.rpy`）を確認したところ、
**th09のリプレイファイル名の接頭辞は実行ファイル名と異なり`th9_`（`09`ではなく`9`）**
であることが判明した。`canonical_slot`を`"th9_ud0000.rpy"`に修正したところ、リプレイが
正しく一覧に表示され再生できるようになった。touhou-recorderのreports/68・69では
`replay_dest_filename="th9_ud0000.rpy"`と正しく実装されていたが、sattori本体への移植時に
実行ファイル名（`th09.exe`）からの類推で誤った値を書いてしまっていた。

## 方法

touhou-recorderの`games/th09/`・`prefixes/th09-wined3d-gl/`をローカルの`worker/games/th09/`・
`worker/prefixes/th09-wined3d-gl/`へrsyncでコピーし（本番はS3タイトル資産アーカイブ経由、
`upload-title-assets` skill参照）、`worker/assets/replay_end_templates/th09.png`も配置した
上で、`worker/record_th09.py`をローカル単体実行した。

```bash
cd worker
python3 record_th09.py --replay-path games/th09/replay/th9_ud5615.rpy --output /tmp/th09_match.mp4
python3 record_th09.py --replay-path games/th09/replay/th9_03.rpy --output /tmp/th09_story.mp4
```

## 結果

### Matchモード（`th9_ud5615.rpy`、Reimu vs Eiki、Lunatic、8,848フレーム≒147秒）

| 項目 | 結果 |
| --- | --- |
| メニュー自動操作 | 成功（Down×2→Enter→Right→Enter→Enterの全ステップがtouhou-recorder reports/68と同じタイミングで完了） |
| 低速録画フック注入ログ | `InstallFpsLimiterHookD3D8`・`InstallDSoundHook`・`InstallFpsDisplayCorrectionHookTimeGetTime`いずれも`IAT hook OK`（`FPS_LIMIT_TARGET_HZ`未設定のためscale=1.0で無効化された状態での注入確認） |
| 入力注入方式 | DirectInput `GetDeviceState`（95〜97Hz、`GetKeyboardState`ではないことを確認） |
| 終了検知 | 成功（`end_template_rect=(0,0,230,88)`でのテンプレート照合、2連続一致で判定） |
| 録画尺 | 156.4秒（1回目の試行で成功） |
| 重複フレーム率（録画開始15秒以降） | 0.7%（閾値30.0%を十分下回る） |
| 残機（life）監視 | P1側`lives=10`（満タン）を確認（`ScoreMonitorConfig.scoreWidth=0`でスコアは監視せず） |
| 目視確認 | 1P/2P split-screenでMatchリプレイ（Reimu vs Eiki）が正常再生、スペルカード「審判「ラストジャッジメント」」発動・スコア表示・59.88fps表示を確認、処理落ちの兆候なし |

### Storyモード（`th9_03.rpy`、Aya、Normal、46,873フレーム≒781秒）

| 項目 | 結果 |
| --- | --- |
| 録画尺 | 768.7秒（1回目の試行で成功、touhou-recorderのローカル実測768.9秒とほぼ一致） |
| 終了検知 | 成功（テンプレート照合、762.8秒時点で2連続一致） |
| 重複フレーム率（録画開始15秒以降） | 0.4% |
| 残機（life）監視 | プレイ経過に伴いlives値が変化し（10→4→10→5→1→10→5→2→1）、ステージ境界で`lives=10`へリセットされる挙動を複数回確認（report68のユーザー申告仕様と一致） |
| 目視確認 | STAGE 6の戦闘が正常に1P/2P split-screenで再生され、60.00fps表示を確認 |

## 考察・既知の限界

- 本検証はローカル単体実行（`--pulse-sink`未指定・タイトル資産はS3経由ではなくローカル
  コピー）であり、AWS EC2 Fleet実機・自宅ワーカー経由のE2E（アップロード→録画→
  CloudFront DL）は別途必要（Issue #73の完了条件）。EC2上でのth09録画自体は
  touhou-recorder reports/68で実機検証済み（c7i.xlarge、Match/Story/Extra全て重複フレーム率
  3.1%以下）。
- Extraステージ（`th9_04.rpy`）のローカル再検証は行っていない。ロジック自体はモード
  非依存（Storyモードの一種）であり、touhou-recorderで実機確認済み（reports/68）のため
  リスクは低いと判断した。
- 低速録画フック（`fps_limiter_hook_d3d8`等）は`FPS_LIMIT_TARGET_HZ`未設定時の無効化経路
  （scale=1.0）のみを本検証で確認した。低速録画自体の動作確認はtouhou-recorderで実施済み
  （reports/68・69）で、`SLOW_MOTION_SUPPORTED_GAME_IDS`未登録のためユーザー向けには
  そもそも到達しない経路。
- スコア（score）はRVA未特定のため本検証でも監視できていない（`worker/docs/titles/th09.md`
  参照）。デシンクの事後検知はth09では機能しない。
