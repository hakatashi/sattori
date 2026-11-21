# touhou-recorder が作ったクラウドリソースの棚卸しと削除

- **検証日**: 2026-11-21
- **対象**: 旧 touhou-recorder（TR）が手作業・terraform で作ったまま残っていた AWS リソース（us-east-1・eu-south-2・us-west-2）。Issue #397 §4
- **環境**: sattori の本番 AWS アカウント。`aws` CLI の `awscli` ユーザー（読み取り＋削除は、この作業のためユーザーが承認した範囲のみ）
- **結論**: TR 名のリソースを実態と突き合わせて全て削除した。GCP は該当プロジェクトなし。旧 `docs/aws-resources.md` の記載は実態と違っていた（S3バケットは「空」ではなく約41.7GB、キーペアも記載より多い）。sattori のリソースには触れていない

TR の `docs/aws-resources.md`（[`research/touhou-recorder/docs/aws-resources.md`](../../research/touhou-recorder/docs/aws-resources.md)）の一覧を、AWS 上の実態と突き合わせ、削除してよいかを**ユーザーに確認してから**削除した（不可逆な操作のため）。
今後クラウドでの検証は実験ジョブ（[`0075`](../decisions/0075-experiment-jobs-and-experimental-ecr.md)）へ寄せるので、この一覧は更新しない。

## 方法

1. 3リージョンで、TR 名（`touhou-recorder*`）のリソースを読み取りだけで列挙した（EC2のキーペア・SG・インスタンス・EBS・スナップショット・AMI・EIP、ECR、S3、IAM）。
2. sattori の CDK・コードから参照されていないこと（Launch Template は別の SG を使いキーペアを持たない。SG は ENI・他 SG から参照されていない）を確かめた。
3. ユーザーに削除範囲を提示し、**全て削除**の承認を得た。
4. 削除後、同じ列挙で 0 件になったことと、sattori のリソース（ECR `sattori-worker`・`-gpu`、Launch Template、TR 以外のキーペア）が残っていることを確かめた。

## 結果

| リソース | 取り込み時の記載 | 実態 | 結果 |
| --- | --- | --- | --- |
| S3 `touhou-recorder-output-<AWS_ACCOUNT_ID>`（us-east-1） | 「中身は空（0オブジェクト）」 | **81オブジェクト・約41.7GB**（phase43 など検証録画の mp4・ログ） | 中身ごと削除（バージョニングなし） |
| ECR `touhou-recorder-th15`（eu-south-2） | th15単体イメージ（約2.4GB、タグ `test`） | 記載どおり | 削除 |
| セキュリティグループ `touhou-recorder-verify-sg` ×3（us-east-1・eu-south-2・us-west-2） | 記載どおり | 記載どおり。ENI・他SGからの参照なし | 削除 |
| キーペア（TR名） | us-east-1: 1、eu-south-2: 6、us-west-2: 3 | us-east-1: 1、**eu-south-2: 8**（`th15-key`・`th06nc-key` が記載漏れ）、us-west-2: 3 | 12本を削除。TR 以外のキーペア（us-east-1・us-west-2 に各1本）は残した |
| IAM ロール `touhou-recorder-verify-role`・インスタンスプロファイル `touhou-recorder-verify-profile` | EC2 のみ AssumeRole 可。ECR ReadOnly・S3 FullAccess をアタッチ | 記載どおり | プロファイルからロールを外して削除、ポリシーをデタッチしてロールを削除 |
| 稼働中の EC2・EBS ボリューム・スナップショット・EIP（3リージョン） | – | いずれも 0（AMI は eu-south-2 に sattori の GPU ワーカー AMI 2つのみ） | – |
| GCP（terraform の cloudrun / gce） | 使っていない（プロジェクトは削除済みと伏せ字化前の README に記載） | `gcloud projects list`（読み取り）で、名前に touhou・sattori・recorder・replay を含むプロジェクトは無かった | 対応なし |

- 削除した S3 の mp4 は、各検証レポート（`research/touhou-recorder/reports/`）に数値が残っているため、再生成しない。
- **GCP**: TR のプロジェクト名は伏せ字化してあり名前では照合できないため、キーワードでの一致のみ。ユーザーのアカウントには無関係な既存プロジェクトが多数あり、中身は見ていない。`research/touhou-recorder/cloud/` の terraform は使わない（README に明記）。

## 考察・既知の限界

- 一覧は AWS の API で列挙できる範囲。IAM の `ListInstanceProfiles` は権限が無く、プロファイルは名前を指定して存在を確かめた。TR 名以外で TR が作ったリソースがあれば拾えていない。
- 記載と実態のずれ（S3の中身・キーペア2本）は、「削除したリソースを速やかに消す」運用はあっても「実態との突き合わせ」の運用が無かったことによる。
  実験ジョブへ移行したので、手作業のリソースが再び増えない前提になった。
