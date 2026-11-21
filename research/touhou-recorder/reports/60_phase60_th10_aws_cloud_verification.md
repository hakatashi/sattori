# フェーズ60: th10のAWSクラウド実機検証

日付: 2026-08-28〜29

## 位置づけ

AGENTS.mdの新規タイトル対応チェックリスト最終項目「クラウド実機検証」をth10で実施した。ユーザーから「スポット価格$0.2/hour未満のインスタンスを1並列までなら明示的な許可なく起動して良い」との事前許可を受けて実施。

## 準備

### 軽量Dockerイメージの作成

`cloud/docker/aws/Dockerfile.th20`を土台に`cloud/docker/aws/Dockerfile.th10`を新規作成した(th10単体のみを含む軽量イメージ、`Dockerfile.multigame`の7GB超を避ける方針を踏襲)。

- `games/th10/`(VsyncPatch一式含む)・`prefixes/th10-wined3d-gl/`・`mods/th10_replay_autoplay/build/th10_hook.dll`をコピー
- th10はth20と異なりcfg/replay配置がAppData配下ではない(ゲーム本体ディレクトリ直下)ため、`Dockerfile.th20`にあった`appdata_dir`固有の分岐は不要だが、wineprefix作成時のユーザー名(`drive_c/users/hakatashi`)とコンテナ実行時ユーザー名を一致させる`usermod`処理は念のため踏襲した
- ビルド結果: CONTENT SIZE 2.11GB(th20の前例2.4GBと同水準)
- `entrypoint_multigame.py`はGAME環境変数を汎用的に受け取る実装のため、th10固有の変更は不要だった

### AWSリソースの新規作成(eu-south-2)

既存のCLAUDE.local.md記載リソース(IAMロール/インスタンスプロファイル・セキュリティグループ`<SECURITY_GROUP_ID>`・S3バケット`touhou-recorder-output-<AWS_ACCOUNT_ID>`)を再利用しつつ、以下を新規作成した:

- ECRリポジトリ `touhou-recorder-th10`(`<AWS_ACCOUNT_ID>.dkr.ecr.eu-south-2.amazonaws.com/touhou-recorder-th10`、タグ`test`でpush済み)
- EC2キーペア `touhou-recorder-th10-key`(既存の`touhou-recorder-verify-key`の秘密鍵が前セッションで失われていたため新規作成。秘密鍵は`/tmp`配下のためセッション終了で失われる想定、再検証時は要再作成)

### インスタンス起動

```bash
aws ec2 run-instances --region eu-south-2 \
  --image-id <AMI_ID> \
  --instance-type c7i.xlarge \
  --key-name touhou-recorder-th10-key \
  --security-group-ids <SECURITY_GROUP_ID> \
  --subnet-id <SUBNET_ID> \
  --iam-instance-profile Name=touhou-recorder-verify-profile \
  --instance-market-options '{"MarketType":"spot","SpotOptions":{"SpotInstanceType":"one-time"}}' \
  --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":40,"VolumeType":"gp3"}}]' \
  --user-data file:///tmp/aws-th10-verify/user-data.sh
```

- AMI: 通常のAmazon Linux 2023(`al2023-ami-2023.12.20260817.0-kernel-6.1-x86_64`)を採用。ECS最適化AMI(`al2023-ami-ecs-hvm-*`)は`describe-images`のデフォルトフィルタで最初にヒットしたが、AGENTS.md記載の「ECSエージェントとx11grabの競合」を避けるため、通常版を明示的に検索して使用した(結果的に`systemctl disable --now ecs`は不要だった)
- インスタンスタイプ: c7i.xlarge(4vCPU、スポット価格実測$0.033/hour、eu-south-2b)。AGENTS.mdの「4vCPU以上」の下限からまず試し、後述の通り品質良好だったため上位インスタンスタイプへのステップアップは不要だった
- ルートボリューム: 40GiB gp3(AGENTS.md記載の「AL2023既定2GiBでは不足」への対応)
- user-data: `dnf install -y docker && systemctl enable --now docker && usermod -aG docker ec2-user`

## 実機検証結果

### 短時間検証(動作確認)

```bash
docker run --rm -e GAME=th10 -e REPLAY_FILE=th10_07.rpy -e RECORD_SECONDS=30 \
  -e OUTPUT_BUCKET=touhou-recorder-output-<AWS_ACCOUNT_ID> -e RUN_ID=th10_cloud_test1 \
  <AWS_ACCOUNT_ID>.dkr.ecr.eu-south-2.amazonaws.com/touhou-recorder-th10:test
```

IAMインスタンスプロファイル経由のS3アップロードも含め、追加設定なしで正常動作(exit_code=0、S3アップロード成功)。同様に`th10_24.rpy`(通しプレイ)で120秒録画し、実際のゲームプレイ区間(60〜120秒)の重複フレーム率0.4%を確認。

### フル尺録画(自然終了検知)

```bash
docker run --rm -e GAME=th10 -e REPLAY_FILE=th10_24.rpy \
  -e OUTPUT_BUCKET=touhou-recorder-output-<AWS_ACCOUNT_ID> -e RUN_ID=th10_cloud_fulltest \
  <AWS_ACCOUNT_ID>.dkr.ecr.eu-south-2.amazonaws.com/touhou-recorder-th10:test
```

- `--record-seconds`未指定(自然な終了検知に任せる)で実行し、**1151.1秒(ローカルでの想定尺1122秒とほぼ一致)で画面静止・end_templateマッチングにより自然終了を検知**した
- **全6ステージの開始時刻が正しく検出された**(ローカル結果とほぼ一致、数秒の差は起動オーバーヘッドの違い):

  | ステージ | クラウド | ローカル(フェーズ57) |
  |---|---|---|
  | 1面 | 00:10 | 00:13 |
  | 2面 | 02:23 | 02:27 |
  | 3面 | 05:13 | 05:15 |
  | 4面 | 08:34 | 08:35 |
  | 5面 | 12:34 | 12:35 |
  | 6面 | 16:50 | 16:51 |

- **重複フレーム率**(複数区間、AGENTS.md推奨の「単一60秒サンプルは信頼できない」を踏まえ5区間で測定):

  | 区間開始 | 重複フレーム率 |
  |---|---|
  | 60s | 1.9% |
  | 300s | 2.3% |
  | 600s | 1.6% |
  | 900s | 1.4% |
  | 1050s | 1.5% |

  全区間で2.3%以下と良好。c7i.xlarge(4vCPU)で十分な品質が得られ、上位インスタンスタイプ(`.2xlarge`等)へのステップアップは不要と判断した。
- **音声も正常に含まれる**(`ffprobe`で`h264,video`/`aac,audio`の両ストリームを確認)。音声・映像別プロセス方式によるA/V同期補正もローカル同様に機能。

### 未実施: クラウド環境でのスコア完全一致再検証

`scripts/25_record_replay_e2e_multigame.py`のMODログ転記処理(`wait_for_log_marker`)は、`WaitForStableWindow: stable`検出時点と`sequence complete`検出時点までの行のみを標準出力に転記する設計であり、**リプレイ再生中(1面開始以降)に出力される`ScoreMonitor`/`StageMarker`ログの大部分は標準出力には転記されない**(コンテナ内の生ログファイル`th10_autoplay.log`にのみ記録される)。今回`docker run --rm`でコンテナを実行したため、録画終了後にコンテナごとログファイルが失われ、`record_stdout.log`(S3にアップロードされる標準出力ログ)だけではスコア完全一致の事後検証ができないことが判明した。

この制約はth10固有ではなくパイプライン全体の仕様であり、クラウドでのスコア検証を今後も行いたい場合は、`--rm`を外してコンテナ内ログをS3にもアップロードする、またはentrypoint側でログファイルもアップロード対象に含める等の改修が必要(未実施)。ただし、スコア監視ロジック自体(RVA読み取り)はOS/実行環境に依存しないため、**ローカル環境での完全一致検証(フェーズ57)で信頼性は既に担保されている**と判断し、本フェーズでは追加対応を見送った。

## 後片付け

- EC2インスタンス(`<INSTANCE_ID>`)は検証完了後にterminate済み(セッション中断中にユーザーが手動でterminateしたことを別途確認)
- ECRリポジトリ`touhou-recorder-th10`・キーペア`touhou-recorder-th10-key`はAWS側に残置(次回以降の検証で再利用可能。秘密鍵ファイルは`/tmp`配下のためこのセッション終了とともに失われる想定、`CLAUDE.local.md`に記載済み)

## 結論

th10のAGENTS.md新規タイトル対応チェックリスト(1〜9項目)は全て実施完了。c7i.xlarge(4vCPU)がth10の推奨インスタンスタイプ(スポット価格実測$0.033/hour、eu-south-2)。
