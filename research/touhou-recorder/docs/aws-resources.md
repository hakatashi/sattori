# AWS残存リソース管理

このドキュメントでは、AWS上に現在残存している検証用リソースの最新情報を管理します。

## 運用ルール

- **現在残存しているリソースの最新情報のみ**をシンプルに記録する。
- **削除したリソースはドキュメントからも速やかに削除する**（過去の削除履歴や打ち消し線は残さない）。
- 新規にリソースを作成した場合は、該当リージョンの表に追記する。
- EC2インスタンス本体は検証終了後に都度terminateすることを原則とし、常時課金を防ぐ。
- S3バケット・ECRイメージ等のストレージ課金が発生するリソースは中身の有無を含め定期的に確認する。

アカウントID: `<AWS_ACCOUNT_ID>`

---

## us-east-1

| リソース種別 | 識別子 | 補足 |
|---|---|---|
| IAMロール | `touhou-recorder-verify-role` (`arn:aws:iam::<AWS_ACCOUNT_ID>:role/touhou-recorder-verify-role`) | `AmazonEC2ContainerRegistryReadOnly`・`AmazonS3FullAccess`をアタッチ。EC2のみAssumeRole可 |
| IAMインスタンスプロファイル | `touhou-recorder-verify-profile` | 上記ロールを紐付け済み |
| セキュリティグループ | `touhou-recorder-verify-sg` (`<SECURITY_GROUP_ID>`, VPC `<VPC_ID>`) | SSH(22番、0.0.0.0/0)許可 |
| EC2キーペア | `touhou-recorder-verify-key` (`<KEY_PAIR_ID>`) | 秘密鍵はスクラッチパッド配下（セッション終了で失われる想定、再検証時は要再作成） |
| S3バケット | `touhou-recorder-output-<AWS_ACCOUNT_ID>` | 録画データ保存先。中身は空（0オブジェクト） |

### 削除コマンド

```bash
# S3バケット
aws s3 rm s3://touhou-recorder-output-<AWS_ACCOUNT_ID> --recursive
aws s3api delete-bucket --bucket touhou-recorder-output-<AWS_ACCOUNT_ID> --region us-east-1

# セキュリティグループ・キーペア
aws ec2 delete-security-group --region us-east-1 --group-id <SECURITY_GROUP_ID>
aws ec2 delete-key-pair --region us-east-1 --key-name touhou-recorder-verify-key

# IAMインスタンスプロファイル・ロール
aws iam remove-role-from-instance-profile --instance-profile-name touhou-recorder-verify-profile --role-name touhou-recorder-verify-role
aws iam delete-instance-profile --instance-profile-name touhou-recorder-verify-profile
aws iam detach-role-policy --role-name touhou-recorder-verify-role --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly
aws iam detach-role-policy --role-name touhou-recorder-verify-role --policy-arn arn:aws:iam::aws:policy/AmazonS3FullAccess
aws iam delete-role --role-name touhou-recorder-verify-role
```

---

## eu-south-2

※IAMロール/インスタンスプロファイルはグローバルリソースのためus-east-1のものを共有。

| リソース種別 | 識別子 | 補足 |
|---|---|---|
| セキュリティグループ | `touhou-recorder-verify-sg` (`<SECURITY_GROUP_ID>`, VPC `<VPC_ID>`) | SSH(22番、0.0.0.0/0)許可 |
| EC2キーペア | `touhou-recorder-verify-key` (`<KEY_PAIR_ID>`) | 秘密鍵はスクラッチパッド配下 |
| EC2キーペア | `touhou-recorder-th10-key` | 秘密鍵は`/tmp`配下 |
| EC2キーペア | `touhou-recorder-th12-key` | 秘密鍵は`/tmp`配下 |
| EC2キーペア | `touhou-recorder-th09-key` | 秘密鍵は`/tmp`配下 |
| EC2キーペア | `touhou-recorder-th128-key` | 秘密鍵は`/tmp`配下 |
| EC2キーペア | `touhou-recorder-th06c-key` | 秘密鍵は`/tmp`配下 |
| ECRリポジトリ | `touhou-recorder-th15` (`<AWS_ACCOUNT_ID>.dkr.ecr.eu-south-2.amazonaws.com/touhou-recorder-th15`) | th15単体軽量イメージ（タグ`test`、約2.4GB）push済み。th15検証用 |

### 削除コマンド

```bash
# ECRリポジトリ
aws ecr delete-repository --region eu-south-2 --repository-name touhou-recorder-th15 --force

# セキュリティグループ・キーペア
aws ec2 delete-security-group --region eu-south-2 --group-id <SECURITY_GROUP_ID>
aws ec2 delete-key-pair --region eu-south-2 --key-name touhou-recorder-verify-key
aws ec2 delete-key-pair --region eu-south-2 --key-name touhou-recorder-th10-key
aws ec2 delete-key-pair --region eu-south-2 --key-name touhou-recorder-th12-key
aws ec2 delete-key-pair --region eu-south-2 --key-name touhou-recorder-th09-key
aws ec2 delete-key-pair --region eu-south-2 --key-name touhou-recorder-th128-key
aws ec2 delete-key-pair --region eu-south-2 --key-name touhou-recorder-th06c-key
```

---

## us-west-2

| リソース種別 | 識別子 | 補足 |
|---|---|---|
| セキュリティグループ | `touhou-recorder-verify-sg` (`<SECURITY_GROUP_ID>`, VPC `<VPC_ID>`) | SSH(22番)を作業環境のIPに限定(フェーズ84で作業元IPを`<HOME_GLOBAL_IP>/32`へ更新) |
| EC2キーペア | `touhou-recorder-th06nc-key` | 秘密鍵はスクラッチパッド配下(散逸済み、再検証時は要再作成) |
| EC2キーペア | `touhou-recorder-th15-gpu-key` | 秘密鍵は`/tmp/touhou-recorder-th15-gpu-key.pem`配下(散逸済み、再検証時は要再作成) |
| EC2キーペア | `touhou-recorder-nvenc-key`(フェーズ84で新規作成) | 秘密鍵は`/tmp/aws-gpu-nvenc/nvenc-key.pem`配下 |

### 削除コマンド

```bash
aws ec2 delete-security-group --region us-west-2 --group-id <SECURITY_GROUP_ID>
aws ec2 delete-key-pair --region us-west-2 --key-name touhou-recorder-th06nc-key
aws ec2 delete-key-pair --region us-west-2 --key-name touhou-recorder-th15-gpu-key
aws ec2 delete-key-pair --region us-west-2 --key-name touhou-recorder-nvenc-key
```
