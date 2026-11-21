# フェーズ16: AWSクラウド環境での録画動作検証(EC2 Spot + CloudFront)

日付: 2026-07-16

## 目的

フェーズ15でGCP環境(Cloud Run Job・Compute Engine)でのth07リプレイ録画を実証し、AWS側は公開料金データに基づく試算のみに留めていた。本フェーズでは、実際にAWSプロジェクト(アカウント<AWS_ACCOUNT_ID>)上に録画パイプラインをデプロイし、**EC2 Spotインスタンスでの録画完走**と、**CloudFront経由でのダウンロード(egress検証)**を実機で確認した。リージョンはコスト最安の`us-east-1`(バージニア北部)を使用した。

## 結論(要約)

- **EC2 Spotインスタンス(c6i.xlarge、4vCPU/8GB)でth07リプレイ(`th7_07.rpy`)の実写と同等の録画が正常に完走することを実証した**(実際に東方妖々夢のゲームプレイ映像・音声を含むmp4をダウンロードし、目視・ffprobe・音量解析・重複フレーム率で検証済み)
- **S3を非公開のままCloudFront(Origin Access Control経由)で配信し、実際にダウンロードできることを確認した**。CloudFrontの無料枠(1TB/月・永年無料)により、本検証のダウンロード(644MB)は課金対象にならなかった
- 重複フレーム率(60秒サンプル)は約8.0%で、GCP側のCloud Run Job(4vCPU、約7%)とほぼ同水準の品質だった。録画時間も850.8秒とGCP実測値(849.8〜852.7秒)に極めて近く、**CPUのみでの録画パイプラインはGCP・AWSどちらでも同等の品質で動作する**ことを確認した
- **実測スポット価格は$0.0779/時間**(依頼時点のus-east-1a)で、フェーズ15試算時の想定値($0.0824/時間、ap-northeast-1相当)よりやや安く、AWS側のコスト優位性がわずかに大きいことが確認できた
- 検証中、**IAM権限不足**(2件)と**terraform-provider-awsの異常なハング**という2種類の環境起因の問題が発生し、いずれも回避・解消した(詳細は「発生した問題と対処」を参照)。特にterraformのハングはAWS側の一時的なSpotキャパシティ不足が引き金になっていた可能性が高く、原因調査の過程でAWS CLIによる直接実行に切り替えて検証を完了させた

## 検証環境

- AWSアカウント: `<AWS_ACCOUNT_ID>`(既存)
- リージョン: `us-east-1`(バージニア北部、コスト最安のため指定)
- コンテナイメージ: `<AWS_ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/touhou-recorder:latest`(ECR)
- 出力先: `s3://touhou-recorder-output-<AWS_ACCOUNT_ID>`(検証後削除)
- 配信: CloudFrontディストリビューション(`d3aijt3opx0eis.cloudfront.net`、検証後削除)
- IaC: Terraform(`cloud/terraform/aws/`)、Docker(`cloud/docker/aws/`)

## アーキテクチャ

### コンテナイメージ(`cloud/docker/aws/Dockerfile`)

GCP版(`cloud/docker/Dockerfile`)とほぼ同一構成(wine 9.0, Xvfb, openbox, ffmpeg, pulseaudio, MS Gothicフォント, python3+numpy+PIL)。アップロード先の変更に伴い、`google-cloud-storage`の代わりに`boto3`を導入した。イメージサイズは content size で約1.49GB(圧縮後、layer構成はGCP版と実質同一)。

エントリポイント(`cloud/docker/aws/entrypoint.py`)はGCP版と同じ流れ(PulseAudio起動 → `scripts/11_record_th07_replay_e2e.py`実行 → 結果をS3へアップロード)で、アップロード処理のみ`boto3`のS3クライアントに置き換えた。

### EC2(Spotインスタンス、`cloud/terraform/aws/main.tf`)

Amazon Linux 2023(AL2023)上でDockerを`dnf install`し、`docker run`で録画ワーカーコンテナを実行、完了後に`shutdown -h now`で自己終了する設計(GCPのCOS+startup-script方式と同じ思想)。EC2インスタンスにはS3書き込み・ECR pull権限を持つIAMロール(インスタンスプロファイル経由)を付与し、認証情報をコンテナに直接埋め込まない構成にした。

### S3 + CloudFront(`cloud/terraform/aws/main.tf`)

S3バケットは`aws_s3_bucket_public_access_block`で完全非公開にし、CloudFrontの Origin Access Control(OAC)経由でのみ`s3:GetObject`を許可するバケットポリシーを設定した。これによりS3への直接アクセスを塞ぎつつ、CloudFront経由での配信・無料枠の活用を両立できる。

## 発生した問題と対処

### 1. IAMユーザーの権限不足(2件)

検証に使用したIAMユーザー(`awscli@HakataMatrix`)には、EC2インスタンスプロファイルの作成・IAMロールの一覧参照系の権限が一部欠けていた。

- `iam:CreateInstanceProfile`・`iam:AddRoleToInstanceProfile`等が不足しており、`terraform apply`が`aws_iam_instance_profile`の作成でAccessDeniedとなった。ユーザーに権限追加を依頼し解消(ユーザー確認済み)
- `terraform destroy`の最終段階で`iam:ListInstanceProfilesForRole`が不足しており、IAMロールの削除に失敗。インスタンスプロファイル・インラインポリシーは既に削除済みで依存関係が無かったため、`aws iam delete-role`を直接実行して解消し、`terraform state rm`でstateを整合させた

### 2. terraform-provider-awsが`aws_instance`作成で20分以上ハング

`terraform apply`が`aws_instance.recorder`の作成(Spotインスタンス+IAMインスタンスプロファイル構成)で20分以上「Still creating...」のまま進行しなくなった。調査の結果:

- `terraform-provider-aws`プロセスにAWSへのTCP接続が一切確立されておらず(`ss -tnp`で確認)、実際にはAWS APIへのリクエストすら送られていない状態だった
- 診断のためプラグインプロセスにSIGQUITを送信したところ、terraform自体が「Plugin did not respond」で異常終了した
- 同一パラメータ(AMI・サブネット・セキュリティグループ・IAMインスタンスプロファイル・Spotオプション)でAWS CLIから`aws ec2 run-instances --dry-run`を直接実行したところ2秒未満で成功し、AWS API側・IAM反映側には問題が無いことを確認した
- 実際に(dry-runなしで)`run-instances`を実行すると、選択されたサブネットのAZ(`us-east-1b`)で**`InsufficientInstanceCapacity`**(c6i.xlarge Spotのキャパシティ不足)が返った。dry-runはキャパシティチェックを行わないため、この問題はdry-runでは検出できなかった
- 別のAZ(`us-east-1a`)のサブネットを指定したところ、AWS CLIから3秒程度で正常にインスタンスが起動した

以上から、terraformのハングは**Spotキャパシティ不足のエラーをterraform-provider-aws(v5.100.0)が適切にリトライ終了・報告できず、無限に待機し続けるバグ的挙動**が引き金になった可能性が高いと考えられる。この問題は本フェーズのth07録画自体とは無関係な、terraformツールチェーン固有の問題である。

回避策として、`cloud/terraform/aws/main.tf`の`data "aws_subnets" "default"`にAZフィルタを追加し、`us-east-1b`を除外するよう修正した。実際のインスタンス起動はAWS CLIから直接行い(`aws ec2 run-instances`)、terraformでは他のリソース(S3・CloudFront・IAM・セキュリティグループ)のみを管理する形で検証を完了させた。恒久的な自動化を行う場合は、この`aws_instance`起動ステップをterraform以外の手段(AWS CLI・SDK・別のIaCツール、もしくはterraform-provider-awsのバージョン変更)で行うことを推奨する。

## 動作検証結果

| 項目 | 結果 |
|---|---|
| インスタンス | EC2 Spot `c6i.xlarge`(4vCPU/8GB)、AZ: `us-east-1a` |
| 実行結果 | ✅成功(リプレイ全編を録画し、S3へのアップロードまで完走) |
| 録画時間 | 850.8秒(`th7_07.rpy`、GCP実測値849.8〜852.7秒とほぼ同一) |
| 出力ファイルサイズ | 644,375,020 bytes(約644MB、GCP実測の約600MBと近い水準) |
| 重複フレーム率(60秒サンプル) | 約8.0%(3599フレーム中3311ユニーク。GCP Cloud Run Job 4vCPU実測の約7%と同水準) |
| 映像 | 640x480, 60fps, h264(ffprobeで確認) |
| 音声 | AAC 48kHz、mean_volume -10.8dB, max_volume 0.0dB(無音でないことを確認) |
| 起動〜録画開始までのオーバーヘッド | 約72秒(EC2起動 → dnf install docker → ECR pull(圧縮約1.49GB) → コンテナ起動 → PulseAudio初期化まで) |
| CloudFront経由ダウンロード | ✅成功。HTTP 200、644MBを約30秒(約172Mbps)で取得。S3は非公開のままOAC経由でのみアクセス許可されていることを確認 |

目視確認(`reports/assets/th07_aws_ec2_frame_60s.png`, `th07_aws_ec2_frame_400s.png`)でも、スコア・HUD・キャラクター・弾幕・日本語フォント(タイトルロゴ等)が正しく描画されていることを確認した。

## コスト実測・試算(2026-07-16時点)

### 実測値

- EC2 Spot `c6i.xlarge`実勢価格(us-east-1a、検証時点): **$0.0779/時間**(市場価格。RunInstances時の`SpotPrice`欄はオンデマンド価格をデフォルトの上限額として表示するだけで、実際の課金単価ではない点に注意)
- CloudFrontでのダウンロード(644MB)は「1TB/月・永年無料」枠内に収まり、実費用は**$0**

### フェーズ15と同一条件での試算(録画1回・30分と仮定、保存期間7日間、egressは無料枠を超過した前提)

実測値(850.8秒/644MBの録画)を比例配分し、フェーズ15のGCP側試算と同じ前提(30分リプレイ、保存7日、ダウンロードは無料枠超過)で再計算した。

| 項目 | 実測ベースの試算値 | フェーズ15時点のAWS試算値(未実測) |
|---|---|---|
| インスタンス稼働時間 | 約31.4分(録画1800秒相当+実測オーバーヘッド約82秒) | 約31.8分(仮定) |
| コンピュート | $0.0407(実測スポット単価$0.0779/時間ベース) | $0.0436(想定単価$0.0824/時間ベース) |
| 保存(7日、S3標準) | $0.0079(動画サイズ比例配分 約1.36GB) | $0.0074 |
| ダウンロード(S3直接、無料枠超過前提) | $0.1224(us-east-1標準egress単価$0.09/GBを適用) | $0.1448(東京向け単価$0.114/GBを適用していたため過大気味) |
| **合計(S3直接、無料枠超過前提)** | **$0.171** | $0.1958 |
| **合計(CloudFront経由、無料枠内)** | **$0.0486** | (未試算) |

実測ベースでは、**実際のスポット単価がフェーズ15の想定よりやや安く、かつus-east-1からのegress単価がフェーズ15で使った東京向け単価より安いため、AWS側の総コストはフェーズ15試算よりも1〜2割ほど小さくなった**。フェーズ15で言及した「CloudFront無料枠を活用すればegressコストを実質ゼロにできる」という仮説も、本フェーズで実際にCloudFront経由のダウンロードを行い、無料枠内で完了することを確認できた(該当箇所: `reports/15_phase15_cloud_deployment_gcp.md`の「追記(egress対策の一案)」)。

### GCPとの比較(参考)

フェーズ15のGCE Spot `e2-highcpu-4`実測ベースの合計コスト($0.1981、egress無料枠超過前提)と比較すると、AWS EC2 Spot(実測ベース、S3直接ダウンロード)は$0.171とやや安く、**CloudFront経由に切り替えるとさらに約3.5倍安い$0.0486まで下がる**。GCPのCloud CDNには同等の永年無料枠が無いため、egressコストを最小化する観点ではAWS + CloudFrontの組み合わせに一定の優位性がある。

## 結論・推奨構成

- **EC2 Spot(`c6i.xlarge`)+ S3 + CloudFront(OAC)の構成は実機で動作することを確認した**。GCP側(GCE Spot `e2-highcpu-4`)と品質・所要時間ともほぼ同水準
- **配信にCloudFrontを使う場合、動画1本あたりのegressコストを実質ゼロにできる**ことを実機で確認した(1TB/月の永年無料枠、1本あたり約1.36GB想定なら月700本超まで無料)。高頻度配信を想定するなら、S3直接ダウンロードよりCloudFront経由を強く推奨する
- **terraformでのEC2インスタンス作成(Spot+IAMインスタンスプロファイルの組み合わせ)は、AWS側の一時的なキャパシティ不足と組み合わさるとterraform-provider-aws側でハングする既知でない不具合に遭遇した**。恒久的な自動化パイプラインを構築する場合は、この部分をAWS CLI/SDK直接呼び出しに置き換えるか、terraformのタイムアウト設定・プロバイダバージョンを別途検証することを推奨する
- **特定AZ(本検証では`us-east-1b`)でSpotキャパシティが枯渇することがある**ため、本番運用では単一AZ固定ではなく複数AZへのフォールバック(EC2 Fleet/Spot Fleetの活用、または単純に複数サブネットを順に試す)を組み込むことが望ましい

## 未検証・今後の課題

- Fargateでの実機検証は未実施(フェーズ15時点の試算のみ)。EC2 Spotより運用はシンプルになるが、コンピュートコストはやや高くなる見込み
- 本検証は`th7_07.rpy`(約14分)のみで実施。より長時間のリプレイや他タイトルでの動作確認は未実施(GCP側と同じ制約)
- CloudFrontのキャッシュ挙動(2回目以降のダウンロードでのオリジンリクエスト削減効果)は検証していない。動画は録画ごとに一意のファイル名になるため、通常運用ではキャッシュヒットは期待できない点に留意
- terraform-provider-awsのハング問題の根本原因(具体的にどのAPI呼び出し・waiterロジックが原因か)は特定できていない。プロバイダのバージョンアップやissueトラッカーの確認は未実施
- EC2側のSpot中断(スポット価格高騰によるインスタンス回収)時の録画リトライ・レジューム機構は未実装・未検証

## 作成した成果物

- `cloud/docker/aws/Dockerfile`, `cloud/docker/aws/entrypoint.py`: AWS版録画ワーカーのコンテナイメージ(S3アップロード対応)
- `cloud/terraform/aws/main.tf`: S3出力バケット・CloudFront(OAC)・IAMロール/インスタンスプロファイル・セキュリティグループの定義。EC2インスタンス自体は`aws_instance`リソースとして定義済みだが、上記の理由によりterraform経由での作成は本フェーズでは行わなかった(定義は将来の再検証・修正のために残してある)
- `reports/assets/th07_aws_ec2_frame_60s.png`, `th07_aws_ec2_frame_400s.png`: AWS上で録画した動画からの抽出フレーム(目視検証用)

## 現在AWS上に残っているリソース

検証終了後、本フェーズで作成したAWSリソース(EC2インスタンス、S3バケットとその中身、CloudFrontディストリビューション・Origin Access Control、IAMロール・インスタンスプロファイル・インラインポリシー、セキュリティグループ、ECRリポジトリとイメージ)は**すべて削除済み**。ローカルのDockerイメージも削除済み。ユーザー側の環境変更として残るのは、IAMユーザー`awscli@HakataMatrix`への権限追加(`iam:CreateInstanceProfile`等)のみ。
