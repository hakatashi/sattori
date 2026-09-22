# 0057. GPUジョブの`eu-south-2a`除外（[0055](0055-exclude-eu-south-2a-from-gpu-fleet.md)）を撤回する

- **状態**: 有効
- **決定日**: 2026-09-22
- **対象**: apps/api / infra
- **関連**: Issue #281、[0055](0055-exclude-eu-south-2a-from-gpu-fleet.md)（Issue #267）

GPUジョブ（`th06nc`・`th15`）のEC2 Fleet候補から`eu-south-2a`を暫定除外していた対策
（`EXCLUDED_GPU_AVAILABILITY_ZONE`、`apps/api/src/ec2.ts`）を撤回し、GPUジョブもCPU系
ジョブと同じ全AZを候補にする。

## 背景

[0055](0055-exclude-eu-south-2a-from-gpu-fleet.md)は、GPUジョブをAZ別に層別した際の
Wineクラッシュ率の偏り（`eu-south-2a`: 6件中4件、`eu-south-2b`: 16件中0件、Fisher正確
検定p=0.0021）を根拠に、原因未特定のまま統計的相関だけで`eu-south-2a`を候補から除外した
暫定措置だった。決定記録自身が「GPUジョブが使えるAZが1つ減るため`g6f`系のSpot枯渇による
起動失敗が増えうる。録画ジョブの起動失敗率を監視すること」とリスクを明記していた。

除外から3日後の2026-09-21、ジョブ`68347c1e-ad3a-40d3-88cf-1c2ddc56fc9d`が
`g6f.xlarge`/`g6f.2xlarge` × `eu-south-2b`/`eu-south-2c`の全4パターンで
`UnfulfillableCapacity`を6回連続で返し、リトライを使い果たして`failed`
（`retries_exhausted`）になった。同日に他3件（`3376c932`・`ecd90646`・`9ebbf418`）も
同様に起動失敗している。0055が予期していたリスクが実際に起きた。

除外後（2026-09-19以降）のGPUジョブをDynamoDBで確認したところ、候補が`eu-south-2b`のみ
になった状態でも7件中2件（`c91f6da1`・`8812dd89`）が`recording_failed`（Wineクラッシュ）
で失敗しており、除外前の`eu-south-2b`のクラッシュ率（DynamoDBの`status`ベースの粗い
集計で概算25%程度）と大差ない。すなわち除外後も`eu-south-2b`単独でクラッシュは発生して
おり、`eu-south-2a`除外によってクラッシュが根絶されたわけではない。

（ただし0055の元の統計はwine.logのクラッシュ検知ログを基準にしており、リトライで最終的
に`done`になったジョブも「クラッシュ経験あり」としてカウントしていた可能性がある一方、
今回の再集計はDynamoDBの`status`だけを見た粗い比較のため、検出粒度が異なり厳密な反証には
ならない。それでも「起動失敗の増加」という実害は`UnfulfillableCapacity`のログから確定的
に確認できる。）

## 決定

- `apps/api/src/ec2.ts`から`EXCLUDED_GPU_AVAILABILITY_ZONE`定数と
  `subnetIdsExcludingAvailabilityZone()`を削除し、`launchRecordingInstance()`は
  GPUジョブ・CPU系ジョブともに`config.ec2.subnetIds`（全AZ）をそのまま`Overrides`に渡す。
- `apps/api/src/config.ts`の`Ec2LaunchConfig.subnetAvailabilityZones`と、
  `infra/lib/sattori-stack.ts`の環境変数`WORKER_SUBNET_AZS`を削除する（用途がこの除外
  だけだったため）。
- Wineクラッシュ率（特に`eu-south-2a`）のモニタリングは継続する。再度悪化が確認できたら、
  静的なAZ除外ではなく、ジョブ単位の動的なAZ回避リトライ（同じAZでクラッシュしたら次の
  試行で当該AZを避ける）など、容量枯渇を悪化させない対策を検討する。

## 根拠

- 除外の直接の副作用（起動失敗の増加）がログで確定的に確認できる一方、除外の効果
  （`eu-south-2a`特有のクラッシュ）は除外後のデータで再確認できていない。壊れた動画の
  配信と、録画が全く始まらないことを比べると、サービス停止に近い後者の方がユーザー
  体験上深刻。
- 0055自身が「暫定措置」「原因判明後に撤回」と明記しており、副作用が実害化した以上、
  一度撤回してクラッシュ率を監視し直すのは決定記録の想定通りの運用。
- `eu-south-2`のG系スポットクォータはそもそも小さく（8vCPU）、候補AZを減らすことは
  候補プールを事実上半分にする効果があり、Spot枯渇への耐性という設計目的
  （`docs/decisions/0016-ec2-fleet-instance-type-diversification.md`と同じ考え方）に
  反する。

## 採らなかった選択肢

- **除外を維持しつつ別の容量対策（GPU候補インスタンスタイプの追加、vCPUクォータ増申請等）
  を先に行う**: クォータ増申請はリードタイムが不定でこの障害の即時解決にならない。候補
  インスタンスタイプの追加は新規AMI・実機検証が要り、`AGENTS.md`§3の実機検証原則に照らして
  今回のスコープでは重すぎる。
- **wine.logベースでクラッシュ率を厳密に再集計してから判断する**: より正確だが、
  除外後のサンプル数がまだ少なく（7件）、判断を先延ばしにする間も起動失敗が続く。実害
  （起動失敗）の方が確定的で優先度が高いと判断した。

## 影響範囲

- `apps/api/src/ec2.ts`: `launchRecordingInstance()`。
- `apps/api/src/config.ts`: `Ec2LaunchConfig`（`subnetAvailabilityZones`削除）。
- `infra/lib/sattori-stack.ts`: `WORKER_SUBNET_AZS`削除（CDKデプロイが必要）。
- 撤回後、`eu-south-2a`でのWineクラッシュ率が再度悪化していないか運用時に確認すること。
