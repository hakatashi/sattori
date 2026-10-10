# g6f.2xlarge Spotの容量をeu-south-2とeu-north-1で比べた（GPUマルチリージョン化の前提確認）

- **検証日**: 2026-10-11
- **対象**: g6f.2xlarge（Spot）の起動可否・Spot配置スコア・Spot単価・G系Spotクォータ
- **環境**: 本番AWSアカウント。eu-south-2（本番GPU AMI `ami-08b3f94444612a932`・本番`WorkerVpc`）と、eu-north-1（公開Ubuntu 24.04 AMI・デフォルトVPC）
- **結論**: eu-south-2は全AZで起動できず、eu-north-1は1bでだけ起動できた。Issue #296のコメントで10/9に確認した状況から変わっていない

GPUワーカーのマルチリージョン化（Issue #296、[`decisions/0061`](../decisions/0061-gpu-capacity-fallback-to-eu-north-1.md)）を
設計する前に、両リージョンでいま実際にg6f.2xlargeを起動できるかを確かめた。読み取り専用の指標
（Spot配置スコア・単価・LaunchFnの失敗ログ）と、`run-instances`による実起動の両方で見た。

## 目的

「eu-south-2で容量不足のときだけeu-north-1へ逃がす」という設計に、実際に逃がす意味があるか
（eu-north-1で取れるか）を、設計直前の時点で確認する。

## 方法

1. 本番に稼働中のEC2インスタンス・Step Functions実行が無いことを確認した。
2. 読み取り専用の指標を取った。
   - `aws ec2 get-spot-placement-scores --region us-east-1 --instance-types g6f.2xlarge --target-capacity 1 [--single-availability-zone] --region-names eu-south-2 eu-north-1`
     （このAPIはeu-south-2では提供されていないため、us-east-1のエンドポイントから引いた）
   - `describe-spot-price-history`（直近3日、Linux/UNIX）
   - LaunchFnのCloudWatch Logsで`UnfulfillableCapacity`/`InsufficientInstanceCapacity`を時間別に数えた（直近3日）
   - `service-quotas get-service-quota`（L-3819A6DF: All G and VT Spot Instance Requests）
3. 各AZで`run-instances`を1回ずつ試した（Spot・one-time・UserData無し・IAMロール無し）。
   起動できたものは即`terminate-instances`し、残ったSpotリクエストも`cancel-spot-instance-requests`で取り消した。
   AMIはeu-south-2では本番GPU AMI、eu-north-1では公開Ubuntu AMI（容量はAMIに依存しない）。

## 結果

### 実起動（2026-10-11 18:09〜18:10 UTC、各AZ1回）

| リージョン | AZ | 結果 |
| --- | --- | --- |
| eu-south-2 | 2a | `InsufficientInstanceCapacity` |
| eu-south-2 | 2b | `InsufficientInstanceCapacity` |
| eu-south-2 | 2c | `InsufficientInstanceCapacity` |
| eu-north-1 | 1a | `InsufficientInstanceCapacity` |
| eu-north-1 | 1b | **起動成功**（i-0c9a6f6a7dd30d110、即terminate。Spotリクエストも取り消し済み） |

エラーメッセージは「他のAZなら取れる」と案内したが、実際には全AZで失敗した（10/9の試行と同じ）。

### Spot配置スコア（1〜10、g6f.2xlarge×1、同時刻）

| 単位 | eu-south-2 | eu-north-1 |
| --- | --- | --- |
| リージョン | 1 | **9** |
| AZ | 2a・2b・2c とも 1 | 1a（eun1-az1）1、**1b（eun1-az2）9** |

### Spot単価（直近の値、USD/時）

| eu-south-2a | eu-south-2b | eu-south-2c | eu-north-1a | eu-north-1b |
| --- | --- | --- | --- | --- |
| 0.131 | 0.160 | 0.529 | 0.088 | 0.104 |

### LaunchFnの容量不足ログ（件数/時、UTC）

10/8 15時台34件・16時台6件、10/9 4〜15時台で計82件、10/10 9〜17時台で計204件。10/10はほぼ毎時出ている。

### G系Spotクォータ（L-3819A6DF）

| eu-south-2 | eu-north-1 |
| --- | --- |
| 32 vCPU | **8 vCPU** |

eu-north-1は10/7にサポートから「32へ引き上げた」と連絡を受けているが、適用値は8のままだった。
代わりに **On-Demand** のG枠（L-DB2E81BA）が32になっており、申請と異なる枠が引き上げられた
可能性が高い（申請履歴はawscliユーザーの権限では読めず未確認）。

## 考察・既知の限界

- 実起動は各AZ1回ずつの瞬間値。ただし10/9（Issueのコメント）と10/11で同じ傾向（eu-south-2全滅・
  eu-north-1bだけ取れる）が出ており、配置スコアも同じ傾向を示している。
- eu-north-1にも余裕は無い（1aは取れず、1bの1AZ頼み）。フォールバック先を足すことで容量不足の
  失敗は減るはずだが、無くなるわけではない。
- eu-north-1のクォータが8 vCPUのままだと、フォールバック先で同時に動かせるのはg6f.2xlarge 1台だけ。
  訂正されるまでは、2台目のフォールバックが`VcpuLimitExceeded`/`MaxSpotInstanceCountExceeded`で失敗する。
