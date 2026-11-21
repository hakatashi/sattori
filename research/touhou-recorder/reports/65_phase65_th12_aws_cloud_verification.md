# フェーズ65: th12のAWSクラウド実機検証

日付: 2026-08-31

## 位置づけ

AGENTS.mdの新規タイトル対応チェックリスト最終項目「クラウド実機検証」をth12で実施した。ユーザーから「0.2USD/hour未満のスポット価格のインスタンスを明示的な許可なく起動して構わない」との事前許可を受けて実施。これにより、フェーズ61〜65でth12のチェックリスト全項目(1〜9)が完了した。

## 準備

### 軽量Dockerイメージの作成

`cloud/docker/aws/Dockerfile.th10`(フェーズ60)を土台に`cloud/docker/aws/Dockerfile.th12`を新規作成した(th12単体のみを含む軽量イメージ、`Dockerfile.multigame`の7GB超を避ける方針を踏襲)。

- `games/th12/`(VsyncPatch一式・検証用リプレイ25本含む)・`prefixes/th12-wined3d-gl/`・`mods/th12_replay_autoplay/build/th12_hook.dll`をコピー
- th12はth10と同様cfg/replay配置がAppData配下ではない(ゲーム本体ディレクトリ直下)ため、th20固有の`appdata_dir`分岐は不要
- `entrypoint_multigame.py`はGAME環境変数を汎用的に受け取る実装のため、th12固有の変更は不要だった

### AWSリソースの新規作成(eu-south-2)

既存のCLAUDE.local.md記載リソース(IAMロール/インスタンスプロファイル・セキュリティグループ`<SECURITY_GROUP_ID>`・S3バケット`touhou-recorder-output-<AWS_ACCOUNT_ID>`・サブネット`<SUBNET_ID>`)を再利用しつつ、以下を新規作成した:

- ECRリポジトリ `touhou-recorder-th12`(`<AWS_ACCOUNT_ID>.dkr.ecr.eu-south-2.amazonaws.com/touhou-recorder-th12`、タグ`test`でpush済み)
- EC2キーペア `touhou-recorder-th12-key`(秘密鍵は`/tmp`配下のためセッション終了で失われる想定、再検証時は要再作成)

### インスタンス起動

th10のフェーズ60と全く同じ構成(AMI・インスタンスタイプ・ブロックデバイス設定)をそのまま踏襲:

```bash
aws ec2 run-instances --region eu-south-2 \
  --image-id <AMI_ID> \
  --instance-type c7i.xlarge \
  --key-name touhou-recorder-th12-key \
  --security-group-ids <SECURITY_GROUP_ID> \
  --subnet-id <SUBNET_ID> \
  --iam-instance-profile Name=touhou-recorder-verify-profile \
  --instance-market-options '{"MarketType":"spot","SpotOptions":{"SpotInstanceType":"one-time"}}' \
  --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":40,"VolumeType":"gp3"}}]' \
  --user-data file:///tmp/aws-th12-verify/user-data.sh \
  --associate-public-ip-address
```

- インスタンス: `<INSTANCE_ID>`(c7i.xlarge、4vCPU、eu-south-2b、スポット価格実測$0.0316/hour)
- AMI: 通常のAmazon Linux 2023(`al2023-ami-2023.12.20260817.0-kernel-6.1-x86_64`、ECS最適化AMIではない通常版)
- user-data: `dnf install -y docker && systemctl enable --now docker && usermod -aG docker ec2-user`

## 実機検証結果

### 短時間検証(動作確認)

```bash
docker run --rm -e GAME=th12 -e REPLAY_FILE=th12_02.rpy -e RECORD_SECONDS=40 \
  -e OUTPUT_BUCKET=touhou-recorder-output-<AWS_ACCOUNT_ID> -e RUN_ID=th12_cloud_test1 \
  <AWS_ACCOUNT_ID>.dkr.ecr.eu-south-2.amazonaws.com/touhou-recorder-th12:test
```

IAMインスタンスプロファイル経由のS3アップロードも含め、追加設定なしで正常動作(exit_code=0、S3アップロード成功)。フェーズ61で実装した`force_window_map`対策(th12固有のウィンドウ最小化不具合)もクラウド環境で問題なく機能し、ウィンドウ検出に成功した。実ゲームプレイ区間(15〜45秒)の重複フレーム率0.9%。

### フル尺録画(自然終了検知)

| リプレイ | 総録画時間 | 重複フレーム率(開始15秒以降) |
|---|---|---|
| `th12_02.rpy`(通常ステージ、Hard、6面通し) | 1767.8秒 | **0.6%** |
| `th12_01.rpy`(Extraステージ) | 725.2秒 | **2.0%** |

いずれもexit_code=0で正常終了、S3アップロードも成功。**Extraステージも良好な結果**となり、フェーズ62でこのローカル開発機で観測された処理落ち(重複フレーム率26.2%)がクラウドの4vCPU環境では全く再現しないことを確認した(フェーズ64で特定した「ローカル機の別プロセス(mongod)競合が原因」という結論と整合する)。

動画をS3から`runs/th12_verification/cloud/th12_cloud_normal_full.mp4`・`th12_cloud_extra_full.mp4`にダウンロードし、t=300秒付近のフレームを目視確認した。Extraボス(封獣ぬえ)戦のスペルカード画面が正しく描画されていることを確認した。

### 結論

**th10と同じくc7i.xlarge(4vCPU)がth12の推奨インスタンスタイプ**(スポット価格実測$0.0316/hour、eu-south-2)。品質良好のため上位インスタンスタイプ(`.2xlarge`等)へのステップアップ検証は不要と判断した。

## 後片付け

検証完了後、EC2インスタンス(`<INSTANCE_ID>`)を`terminate-instances`し、`describe-instances`で稼働中インスタンスが無いことを確認した。ECRリポジトリ・キーペアはCLAUDE.local.md記載の運用ルールに従い残置(ユーザーからクリーンアップ指示があるまで保持)。

## AGENTS.md新規タイトル対応チェックリスト完了

フェーズ61〜65で以下の全項目を完了した:

1. 設定確認 ✅(フェーズ61、ウィンドウモード確認・最小化バグ対策)
2. 起動確認 ✅(フェーズ61)
3. MOD開発・動作確認 ✅(フェーズ61、DIKスキャンコード方式に訂正)
4. リプレイ録画確認(通常・Extra両方のフル尺) ✅(フェーズ62)
5. 録画品質確認 ✅(フェーズ62・64・65、真因調査含む)
6. 音ズレ確認 ✅(フェーズ62自動検知・ユーザーによる聴感確認)
7. 低速録画機能 ✅(フェーズ63・64、fps表示補正含む)
8. 内部データ取得機能(score_monitor) ✅(フェーズ61〜64、記録スコア完全一致・オーバーフローバグ検証)
9. クラウド実機検証 ✅(本フェーズ)

**th12(東方星蓮船)のリポジトリ対応は完了した。**
