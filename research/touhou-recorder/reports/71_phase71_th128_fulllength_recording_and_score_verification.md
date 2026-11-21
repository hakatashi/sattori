# フェーズ71: th128のフル尺録画検証(通常・Extra両方)、記録スコアとの完全一致確認

日付: 2026-09-04

## 位置づけ

フェーズ70で構築したth128の環境・MODを使い、AGENTS.mdの新規タイトル対応チェックリストの項目4(フル尺録画、通常/Extra両方)・5(録画品質)・6(音ズレ確認)を完了する。項目7(低速録画)・9(AWS実機検証)は次フェーズ以降。

## Extraリプレイの取得

`games/th128/replay/`に配置されていた5本のリプレイ(`th128_ud0000.rpy`・`th128_01〜04.rpy`)は全てHard/Lunatic難易度で、Extra難易度のリプレイが無かった。`../sattori/.agents/skills/silent-selene/SKILL.md`の手順に従い`GET /replays/th128/json`でリプレイ一覧を取得し、Extra難易度・Standardカテゴリ(TASでない)のリプレイ(Id=84310、プレイヤー"がそりん"、Cirno、スコア100,845,160、2026-05-26投稿)を`GET /replays/th128/84310/download`で取得、`games/th128/replay/th128_extra01.rpy`として配置した。`@sattori/touhou-replay-parser`でパース可能なことを確認済み。

## フル尺録画結果

`scripts/25_record_replay_e2e_multigame.py --game th128 --thprac --replay <file> --output <file>`で2本を録画した(`--thprac`必須、フェーズ70参照)。

| リプレイ | 難易度 | 総録画時間 | 重複フレーム率(録画開始15秒以降) | 検知方式 |
|---|---|---|---|---|
| th128_ud0000.rpy | Hard | 845.7s | 1.1% | 画面静止検知 |
| th128_extra01.rpy | Extra | 1353.8s | 2.2% | 画面静止検知 |

いずれも1回目の試行で成功(リトライなし)。

### 理論尺比較(`@sattori/touhou-replay-parser`のframeCountとの比較)

重複フレーム率だけでは背景アニメーションが常に変化し続けるタイトルの「間延び型」処理落ちを見逃す(`reports/67`参照)ため、理論尺との比較も実施した。

- th128_ud0000.rpy: frameCount=49000(60fps換算816.67s)。実測プレイ時間 = 総録画845.7s − メニュー操作分11s(録画開始15:20:07→sequence complete 15:20:18)− 静止検知待機16s ≈ 818.7s。理論尺超過 **+0.25%**
- th128_extra01.rpy: frameCount=79306(60fps換算1321.77s)。実測プレイ時間 = 総録画1353.8s − メニュー操作分12s(録画開始15:35:55→sequence complete 15:36:07)− 静止検知待機16s ≈ 1325.8s。理論尺超過 **+0.30%**

いずれも良好な値(th09/th10/th12の良好事例と同水準)。このローカル開発機のスペックでは通常・Extra両方とも処理落ちの兆候なし。

## 記録スコアとの完全一致検証(`scripts/53_verify_replay_score.py`)

`scripts/53_verify_replay_score.py`の`GAME_MULTIPLIERS`に`"th128": 10`を追加した(フェーズ70で短時間録画中のHUD表示値との一致により実証済みの換算式)。

```
$ python3 scripts/53_verify_replay_score.py --game th128 games/th128/replay/th128_ud0000.rpy instances/th128-multigame-recording-test/th128_autoplay.log
タイトル      : th128
リプレイ      : th128_ud0000.rpy (Hard / RouteB-1 / koyi)
記録時スコア  : 22,666,770
再生時スコア  : 22,666,770 (内部値2,266,677×10, 最大22,666,770)
判定          : 一致(デシンクなし)

$ python3 scripts/53_verify_replay_score.py --game th128 games/th128/replay/th128_extra01.rpy instances/th128-multigame-recording-test/th128_autoplay.log
タイトル      : th128
リプレイ      : th128_extra01.rpy (Extra / Extra / Gas)
記録時スコア  : 100,845,160
再生時スコア  : 100,845,160 (内部値10,084,516×10, 最大100,845,160)
判定          : 一致(デシンクなし)
```

通常・Extra両方でリプレイ記録スコアと完全一致し、デシンクなしを確認した。フェーズ70で特定したscore RVA(`0x4b4cc4`)・motivation RVA(`0x4b4d64`)の信頼性が、単発のHUD照合だけでなくフル尺2本の完走一致によって裏付けられた。

## 音ズレ確認

両録画とも`scripts/25`の既定動作(映像・音声を別プロセスで録画し、実測起動レイテンシ差分で後mux)で処理された。

- 通常: `video_start=1788502807.100 audio_start=1788502807.693 delta=+0.593s`
- Extra: `video_start=1788503755.616 audio_start=1788503756.213 delta=+0.597s`

いずれも0.6秒弱の一貫した差分で、`-itsoffset`補正付きでmuxされた。`ffmpeg -af volumedetect`で音声トラックが正常な音量(mean -9〜-8.9dB, max 0dB、無音・クリッピングなし)であることを確認した。目視でのフレーム抽出(通常: 中盤のスペルカード戦闘シーン、Extra: 中盤のスペルカード戦闘シーン)でも画面上のfpsカウンター表示が59.9〜60.0fpsで安定しており、映像自体の乱れも無かった。

## 終了画面の仕様訂正(ユーザー申告の「テンプレート照合が有効」を撤回)

ユーザーからは当初「リプレイの再生終了検知はテンプレート照合が有効と思われる」との申告があったが、実機録画で確認したところ、th128の再生終了画面は**「STAGE CLEAR」表示+「Pause Menu」オーバーレイ**(再生終了/タイトルに戻る/もう一度再生する、というメニュー項目)であり、背景にステージクリア時の直前ゲームプレイ画面(スコア・クリアボーナス等がリプレイ内容に依存して変化)が写り込む形式だった。これはth11の終了画面(`reports/36`参照、「直前ゲームプレイ画面の凍結+Pause Menuオーバーレイ」)と全く同じ構造であり、th11と同じ理由(内容非依存の固定テンプレートが作れない)でテンプレート照合には不向きと判断した。

幸い今回の2本のフル尺録画はいずれも`end_template`を設定しない既定状態(画面静止検知のみ)で問題なく成功している(Pause Menuの項目文字自体は明滅しないため、th11で必要だった`still_detect_exclude_rect`も今のところ不要)。よって**th128は`end_template`を設定せず、画面静止検知のみで運用する**方針とし、`GAME_CONFIGS["th128"]`に変更は加えない(現状で既に画面静止検知にフォールバックする設定になっている)。

## 未完了・次フェーズへの持ち越し事項

1. 低速録画機能の実機検証(フックはフェーズ70でインストール済みだが動作未確認)
2. AWSクラウド実機検証(スポット価格0.2USD/hour以下のインスタンスタイプは非明示許可で起動可、とユーザーから事前承認済み)
3. perfect_freeze/ice_power/ice_area/stage(route)のscore_monitor接続(任意、コア項目の score/motivation は検証済み)

## 変更ファイル

- 変更: `scripts/53_verify_replay_score.py`(`GAME_MULTIPLIERS["th128"]=10`追加)
- 新規: `games/th128/replay/th128_extra01.rpy`(SilentSeleneから取得、gitignore対象)
- 新規: `runs/th128_verification/full_normal_hard.mp4`, `runs/th128_verification/full_extra.mp4`(検証録画、gitignore対象)
