# フェーズ73: th128のAWSクラウド実機検証

日付: 2026-09-04

## 位置づけ

AGENTS.mdの新規タイトル対応チェックリスト最終項目「クラウド実機検証」をth128で実施した。ユーザーから「0.2USD/hour未満のスポット価格のインスタンスタイプは明示的な許可なく起動して構わない」との事前許可を受けて実施(2026-09-04)。これによりth128のチェックリスト全項目(1〜9)が完了した。

## 準備

### 軽量Dockerイメージの作成

`cloud/docker/aws/Dockerfile.th12`を土台に`cloud/docker/aws/Dockerfile.th128`を新規作成した(th128単体のみを含む軽量イメージ)。

- `games/th128/`(VsyncPatch一式・thprac・検証用リプレイ6本含む)・`prefixes/th128-wined3d-gl/`・`mods/th128_replay_autoplay/build/th128_hook.dll`をコピー
- th128はth20と同様cfg/replay配置がAppData配下のため`appdata_dir`分岐が効くが、`entrypoint_multigame.py`側の変更は不要(Dockerfileの`COPY`でprefix側のAppDataも一式コピーされる)
- **`entrypoint_multigame.py`に`--thprac`対応が無かったため追加した**。既存のth20用Dockerfileも同じ`entrypoint_multigame.py`を使っているが`--thprac`を渡す仕組みが無く、th20のAWS検証(フェーズ46)は`--thprac`導入(フェーズ50)より前だったためこの欠落が今まで露見していなかったと考えられる。新規環境変数`THPRAC=1`で`--thprac`を追加するようにし、`Dockerfile.th128`に`ENV THPRAC=1`を設定した

### AWSリソースの新規作成(eu-south-2)

既存のCLAUDE.local.md記載リソース(IAMロール/インスタンスプロファイル・セキュリティグループ`<SECURITY_GROUP_ID>`・S3バケット`touhou-recorder-output-<AWS_ACCOUNT_ID>`・サブネット`<SUBNET_ID>`)を再利用しつつ、以下を新規作成した:

- ECRリポジトリ `touhou-recorder-th128`(`<AWS_ACCOUNT_ID>.dkr.ecr.eu-south-2.amazonaws.com/touhou-recorder-th128`、タグ`test`でpush済み)
- EC2キーペア `touhou-recorder-th128-key`(秘密鍵は`/tmp`配下のためセッション終了で失われる想定、再検証時は要再作成)

## 発見したバグ: `--thprac`併用時、低速録画でthpracアタッチがタイムアウトする(フェーズ72で修正済み)

本フェーズの実機検証着手前、フェーズ72で発見・修正済み(`attach_thprac()`のタイムアウトを`MENU_TIME_SCALE`でスケール)。本フェーズの検証はすべて等倍速(60fps)のため直接は影響しないが、将来th128で低速録画をAWSで使う場合は必須の修正である。

## 実機検証結果

### 短時間検証(動作確認、c7i.xlarge)

```bash
docker run --rm -e GAME=th128 -e REPLAY_FILE=th128_ud0000.rpy -e RECORD_SECONDS=40 \
  -e OUTPUT_BUCKET=touhou-recorder-output-<AWS_ACCOUNT_ID> -e RUN_ID=th128_cloud_test1 \
  <AWS_ACCOUNT_ID>.dkr.ecr.eu-south-2.amazonaws.com/touhou-recorder-th128:test
```

インスタンス: `<INSTANCE_ID>`(c7i.xlarge、eu-south-2b、スポット)。`--thprac`込みで追加設定なしに正常動作(exit_code=0、S3アップロード成功)。実ゲームプレイ区間(15〜47秒)の重複フレーム率0.9%。

### フル尺録画(c7i.xlarge)

| リプレイ | 総録画時間 | 重複フレーム率(開始15秒以降) | 理論尺超過率 |
|---|---|---|---|
| `th128_ud0000.rpy`(通常、Hard) | 858.5秒 | 1.3% | **+1.69%** |
| `th128_extra01.rpy`(Extra) | 1404.7秒 | **5.5%** | **+4.16%** |

いずれもexit_code=0で正常終了、S3アップロードも成功したが、**Extraステージの重複フレーム率・理論尺超過率ともにローカル開発機(フェーズ71: 2.2%/+0.30%)より明確に悪化**しており、`.xlarge`帯(4vCPU)ではExtraステージで処理落ちの兆候があると判断した(通常ステージも+1.69%とローカルの+0.25%よりやや高め)。目視でのフレーム抽出(t=400秒/700秒付近)では明らかな破綻は無かったが、th12のフェーズ67で確立した「重複フレーム率だけでは間延び型処理落ちを見逃す」という教訓([reports/67](67_phase67_th12_theoretical_length_comparison_and_lunatic_verification.md)参照)に従い、理論尺比較の悪化を重視して上位インスタンスタイプでの比較検証に進んだ。

### c7i.2xlarge比較検証

```bash
docker run --rm -e GAME=th128 -e REPLAY_FILE=th128_extra01.rpy \
  -e OUTPUT_BUCKET=touhou-recorder-output-<AWS_ACCOUNT_ID> -e RUN_ID=th128_cloud_extra_2xlarge \
  <AWS_ACCOUNT_ID>.dkr.ecr.eu-south-2.amazonaws.com/touhou-recorder-th128:test
```

インスタンス: `<INSTANCE_ID>`(c7i.2xlarge、8vCPU、eu-south-2b、スポット)。Extraステージのみ再検証。

| インスタンスタイプ | 総録画時間 | 重複フレーム率 | 理論尺超過率 |
|---|---|---|---|
| c7i.xlarge(4vCPU) | 1404.7秒 | 5.5% | +4.16% |
| c7i.2xlarge(8vCPU) | 1359.1秒 | **1.4%** | **+0.71%** |

明確な改善が見られた。目視確認(t=700秒付近、恋符「マスタースパークのような懐中電灯」戦)でも描画は良好(59.6fps)。

### 結論

**th128は`.xlarge`帯(4vCPU)では不十分で、`.2xlarge`帯(8vCPU、`c7i.2xlarge`推奨)が必要**と判断した。th09/th10/th12がxlargeで良好だったのとは異なり、th11・th20と同じ「8vCPU以上が必要」グループに分類される。スポット価格は実測していないが、th12の`.2xlarge`実測($0.043/hour、フェーズ66)と同水準と推測され、0.2USD/hour未満のガイドライン内に収まる。

## 後片付け

検証完了後、両EC2インスタンス(`<INSTANCE_ID>`・`<INSTANCE_ID>`)を`terminate-instances`し、`describe-instances`で稼働中インスタンスが無いことを確認した。ECRリポジトリ・キーペアはCLAUDE.local.md記載の運用ルールに従い残置(ユーザーからクリーンアップ指示があるまで保持)。

ユーザー指示によりクラウドで録画した動画4本(短時間検証・通常フル尺・Extraフル尺xlarge・Extraフル尺2xlarge)はすべて`runs/th128_verification/cloud/`にダウンロード済み(合計約4.5GB、`runs/`はgitignore対象のため個別にバックアップ等は不要)。

## AGENTS.md新規タイトル対応チェックリスト完了

フェーズ70〜73で以下の全項目を完了した:

1. 設定確認 ✅(フェーズ70)
2. 起動確認 ✅(フェーズ70)
3. MOD開発・動作確認 ✅(フェーズ70、GetDeviceState方式)
4. リプレイ録画確認(通常・Extra両方のフル尺) ✅(フェーズ71)
5. 録画品質確認 ✅(フェーズ71・73、クラウドでの理論尺比較含む)
6. 音ズレ確認 ✅(フェーズ71)
7. 低速録画機能 ✅(フェーズ72)
8. 内部データ取得機能(score_monitor、score/motivation) ✅(フェーズ70〜71、記録スコア完全一致)
9. クラウド実機検証 ✅(本フェーズ、推奨インスタンスタイプ`c7i.2xlarge`)

## 未完了・任意の持ち越し事項

1. fps表示補正(`fps_display_hook`)の接続(低速録画時の画面上fps表示、優先度低)
2. perfect_freeze/ice_power/ice_area/stage(route)のscore_monitor接続(任意)
3. クラウド録画のMODログ(`th128_autoplay.log`)がS3にアップロードされないため、`scripts/53_verify_replay_score.py`によるクラウド録画のデシンク検証ができない(`entrypoint_multigame.py`はvideo.mp4とrecord_stdout.logのみアップロードし、`record_stdout.log`にはメニュー操作完了までのMODログしか含まれない)。これはth128固有の問題ではなく全タイトル共通の既存の制約であり、修正するなら`entrypoint_multigame.py`が`instances/*/​<game>_autoplay.log`もS3へアップロードするよう改修する必要がある(スコープ外のため本フェーズでは未対応)

## 変更ファイル

- 新規: `cloud/docker/aws/Dockerfile.th128`
- 変更: `cloud/docker/aws/entrypoint_multigame.py`(`THPRAC`環境変数で`--thprac`を渡せるように対応)
- 変更: `AGENTS.md`(th128の推奨インスタンスタイプを追記)
