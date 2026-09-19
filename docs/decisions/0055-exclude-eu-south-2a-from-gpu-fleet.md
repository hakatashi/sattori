# 0055. GPUジョブのEC2 Fleet候補から`eu-south-2a`を暫定除外する

- **状態**: 有効（暫定。原因特定後に撤回すべき）
- **決定日**: 2026-09-19
- **対象**: apps/api / infra
- **関連**: Issue #267、`docs/reports/2026-09-19-th15-wine-crash-detection-verification.md`

GPU描画必須タイトル（`requiresGpuRecording()`、th06nc・th15）のEC2 Fleet Overridesから
`eu-south-2a`のサブネットを除外する（`EXCLUDED_GPU_AVAILABILITY_ZONE`、
`apps/api/src/ec2.ts`）。**CPU系ジョブは対象外**。原因未特定のまま統計的相関だけを根拠に
した暫定措置であり、原因が判明し次第この除外は撤回すること。

## 背景

th15 PR(#264)の本番E2E検証中、GPU(`g6f.2xlarge`)ワーカーで3件立て続けにWineが
クラッシュし、録画が途中で切れたまま配信された。GPUジョブ全22件をAZ別に層別すると
クラッシュ率に極端な偏りがあった。

| AZ | `done`件数 | Wineクラッシュ |
| --- | --- | --- |
| eu-south-2a | 6 | **4** |
| eu-south-2b | 16 | **0** |

Fisher正確検定（片側）で **p = 0.0021**。

「立て続けに起きた」直接の引き金は、Spotの`price-capacity-optimized`が9/18を境に
`eu-south-2a`を選び続けるようになったことだった。同AZのSpot価格は一貫して
`eu-south-2b`より約20%安く（0.061〜0.065 vs 0.071〜0.078）、9/12〜9/17のGPUジョブが
ほぼ全て2bだったのに対し、9/18は5件全てが2aである。

**th15 PR(#264)の変更が原因ではない**。Launch Templateのバージョン履歴から各ジョブの
AMI・UserDataを逆引きした結果、同型の事例が旧AMI・32bitマウント無しの9/13
（`91815815`、理論尺比25%）にも発生していた。

## 決定

- `apps/api/src/ec2.ts`に`EXCLUDED_GPU_AVAILABILITY_ZONE = "eu-south-2a"`を置き、
  `launchRecordingInstance()`がGPUジョブのときだけ
  `subnetIdsExcludingAvailabilityZone()`で絞った一覧を`Overrides`に渡す。
- サブネットとAZの対応は、`infra/lib/sattori-stack.ts`が`WORKER_SUBNET_IDS`と
  **同じ順序**で並べる新しい環境変数`WORKER_SUBNET_AZS`で渡す
  （`config.ec2.subnetAvailabilityZones`）。
- **VPC構成（サブネット自体）は変更しない。** 除外はFleetの`Overrides`組み立て時の
  ランタイムフィルタだけで行う。

## 根拠

- 統計的相関が強い（p=0.0021）こと。実機再現実験
  （`docs/reports/2026-09-19-th15-wine-crash-detection-verification.md`）でクラッシュ
  そのものは再現できたが、**AZ差の機序は再現も特定もできていない**。ハードウェア個体差・
  vGPUスライスの状態などAZ側の環境要因が疑われるが確証はない。
- それでも除外を選ぶのは、被害が「壊れた動画がユーザーへ配信される」ことであり、
  コスト増（GPUジョブのSpot単価が約20%上昇）より優先されるため。GPUジョブは月間の
  ごく一部なので全体コストへの影響は小さい。
- CPU系を対象外にしたのは、有意差が確認されているのがGPU系だけだから。CPU系の候補
  インスタンスタイプは元々このAZを含む複数AZで実機検証済みであり、変更する理由がない。

## 採らなかった選択肢

- **CDK側でサブネット自体を作らない／`WORKER_SUBNET_IDS`から外す**: CPU系ジョブまで
  巻き込んでAZ分散（Spot枯渇耐性、Issue #29）を落とすため不採用。加えて、既存サブネットの
  AZ・CIDRを差し替える形の更新はCloudFormationが新サブネット作成を旧サブネット削除より
  先に試みてCIDR重複で失敗する前例がある（`infra/lib/sattori-stack.ts`のコメント、
  旧us-east-1での`us-east-1e`除外の試み、Issue #29）。
- **`DescribeSubnets`で実行時にAZを引く**: 環境変数を増やさずに済むが、ジョブ起動の
  クリティカルパスにAWS API呼び出しを1回足すことになる。CDKは合成時に各サブネットの
  AZを知っているので、環境変数で渡すのが素直。
- **何もせず`wine.log`検知のリトライだけに任せる**: クラッシュしたぶんのEC2稼働時間が
  丸ごと無駄になり（`a37acd43`は理論尺849秒に対し226秒でクラッシュ）、ユーザーの待ち
  時間も伸びる。検知とリトライは最後の砦であって、そもそも踏まない方がよい。
- **`price-capacity-optimized`を`capacity-optimized`へ変える**: AZ選択の偏りは変わりうるが、
  特定AZを避ける保証がなく、CPU系ジョブのコストにも影響する。

## 影響範囲

- `apps/api/src/ec2.ts`: `EXCLUDED_GPU_AVAILABILITY_ZONE`、
  `subnetIdsExcludingAvailabilityZone()`、`launchRecordingInstance()`。
- `apps/api/src/config.ts`: `Ec2LaunchConfig.subnetAvailabilityZones`（必須）。
- `infra/lib/sattori-stack.ts`: `WORKER_SUBNET_AZS`。**`WORKER_SUBNET_IDS`と順序を
  揃えること**（どちらも同じ`workerSubnets`配列から`.map()`で作っている）。
- GPUジョブが使えるAZが1つ減るため、**`g6f`系のSpot枯渇（`InsufficientInstanceCapacity`）
  による起動失敗が増えうる**。eu-south-2のG系スポットクォータは元々小さいので、
  録画ジョブの起動失敗率を監視すること。
- 原因が特定できたら、この除外を撤回して定数と`subnetAvailabilityZones`の要否を
  見直すこと。
