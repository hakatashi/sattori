# EC2 ワーカーの起動（`ec2.ts` / `sfn/launch.ts`）

EC2 Fleet でワーカーを起動する部分の参照仕様。候補インスタンスタイプ、GPU 系の別系統、
起動の段とリージョンのフォールバック、UserData の中身を扱う。インスタンスタイプ・起動経路・
UserData を変える前に読むこと。[`apps/api/README.md`](../README.md) §4・§7 から分けた。

## 1. EC2 Fleet インスタンスタイプの分散配置（`ec2.ts`, Issue #29）

サブネット（=AZ）×候補インスタンスタイプの全組み合わせを `CreateFleet` の
`Overrides` に渡し、`AllocationStrategy: "price-capacity-optimized"`
（`SingleInstanceType: false`）で配置する。**候補は録画の段ごとに違い、段と候補の一覧は
`packages/shared/src/recordingPlan.ts`の`RECORDING_PLANS`が唯一の出典**（Issue #317、
[`decisions/0066`](../../../docs/decisions/0066-recording-fallback-plan-as-config.md)）。

| 段 | 定数（`recordingPlan.ts`） | 候補インスタンスタイプ |
| --- | --- | --- |
| th06/06c/07/08/09/10のCPU（等倍） | `CPU_XLARGE_INSTANCE_TYPES` | `c7i.xlarge` / `c7a.xlarge` / `c7i-flex.xlarge` / `m7i.xlarge` |
| th11/12/128のCPU（等倍） | `CPU_2XLARGE_INSTANCE_TYPES` | `c7i.2xlarge` / `c7a.2xlarge` / `m7i.2xlarge` |
| 全タイトルのGPUの段（倍速・th20の等倍） | `GPU_INSTANCE_TYPES` | `g6f.2xlarge`のみ（Issue #241・#82・#288、[`decisions/0058`](../../../docs/decisions/0058-speedup-recording-on-gpu-instances.md)）。GPUリースのvCPU量で`getCandidateInstanceTypes(step, { maxVcpu })`が絞る |
| th06ncのCPU低速録画（BC7展開） | `TH06NC_CPU_INSTANCE_TYPES` | `c7i.2xlarge`のみ（[`decisions/0067`](../../../docs/decisions/0067-th06nc-cpu-slow-motion-and-drop-1080p.md)。かつての最後の段`g6.2xlarge`は外した） |
| th15・th20のCPU低速録画 | `CPU_SLOW_MOTION_INSTANCE_TYPES` | `c7i.4xlarge`のみ（[`decisions/0064`](../../../docs/decisions/0064-cpu-slow-motion-and-g6-fallback-on-gpu-shortage.md)） |

> **候補を足す・変える前に
> [`docs/decisions/0016`](../../../docs/decisions/0016-ec2-fleet-instance-type-diversification.md)
> を必ず読むこと**（各候補の実機検証の裏付け・GPU帯が1タイプしかない理由・
> 「同スペック帯だから安全」が繰り返し裏切られている経緯）。インスタンスの起動を
> CDK側へ移さない理由は [`0002`](../../../docs/decisions/0002-ec2-launch-at-runtime-not-iac.md)。
> `CreateLaunchTemplateVersion`の`SourceVersion`に`$Default`ではなく`$Latest`を使う
> 理由（CDKでLaunch Templateを変更してもジョブ起動に反映されないバグの修正）は
> [`0051`](../../../docs/decisions/0051-launch-template-source-version-latest-not-default.md)。

**GPUの段（`platform: "gpu"`）だけは別系統**——GPU用の
Launch Template（`config.ec2.gpuLaunchTemplateId`、AMIはSSM動的解決ではなく
事前構築したカスタムAMIを固定参照）・別ECRイメージ（`config.workerGpuImage`）を
使い、`buildUserData()`が`docker run`に`--gpus all`を追加する
（[`docs/decisions/0046`](../../../docs/decisions/0046-gpu-ec2-instance-and-fixed-ami.md)〜
[`0048`](../../../docs/decisions/0048-separate-ecr-repo-for-gpu-workers.md)）。
ホストのNVIDIA Xorgドライバ（`nvidia_drv.so`・`libglxserver_nvidia.so*`）・32bit
クライアントライブラリ（`libGLX_nvidia.so*`等）はファイル単位で個別マウントする必要が
ある。ディレクトリごとマウントするとコンテナ自身の`xserver-xorg-core`由来モジュール
（`libwfb.so`等）や32bit版Mesaを隠してしまい、前者はXorg起動不能、後者は32bitタイトル
(th15)がGPUを使えずllvmpipeへ静かにフォールバックする（nvidia-container-toolkitは
32bit互換ライブラリを自動マウントしないため。[`0052`](../../../docs/decisions/0052-gpu-xorg-driver-file-level-mount-not-directory.md)・
[`0053`](../../../docs/decisions/0053-mount-32bit-nvidia-client-libraries-for-wine.md)）。

**起動手段は録画の段（`recordingPlan.ts`）で、Spot在庫の枯渇ならその場で次へ進む**（Issue #315・#317、
[`docs/decisions/0063`](../../../docs/decisions/0063-spot-capacity-shortage-is-permanent-within-a-job.md)・[`0066`](../../../docs/decisions/0066-recording-fallback-plan-as-config.md)）。
段を試すループは`launch.ts`の`assignWorker()`、段をLaunch Template・サブネット・イメージへ解決するのは`ec2.ts`の
`launchTierFor()`（一次リージョンならCPU/GPUのテンプレート、`config.ec2.gpuFallback`のリージョンなら固定名の
GPUテンプレート・タグで引いたサブネット・ECRレプリカ、[`0061`](../../../docs/decisions/0061-gpu-capacity-fallback-to-eu-north-1.md)）、
1段の起動は`launchRecordingInstance()`。解決できない段（フォールバック先が未設定の環境）は飛ばす。
枯渇した段（全サブネット×全候補が枯渇、`isTierCapacityExhausted()`）は`JobRecord.capacityExhaustedTargets`へ
記録し、リトライでは飛ばす。全段が尽きたら`launch.ts`が`capacity_exhausted`で直ちに失敗させる。クォータ超過は
従来どおりリトライ。`FleetLaunchError`のメッセージは`handleFailure.ts`の容量不足判定（部分一致）が使うので
形式を崩さないこと。試行ごとに作るLaunch Templateのバージョンは結果によらず消す。管理設定
`forceGpuFallbackRegion`・`skipGpuSteps`（`settings.ts`）は段の除外として読む（`recordingSteps.ts`、本番での
実機検証用）。

フォールバック先で動くワーカーには、そのリージョンの出力バケットとタイトル資産レプリカを渡す
（Issue #313、[`docs/decisions/0062`](../../../docs/decisions/0062-gpu-fallback-region-local-output-and-title-assets.md)、
`workerEnv.ts`・`config.ts`の`dataBucketsFor()`）。どこへ出力したかは、ワーカーがパスと同じ更新で
`JobRecord.outputRegion`に書く。APIはそれを見て配信URLに`/<region>/`を付ける
（`downloads.ts`の`cdnPathFor()`、`config.ts`の`mediaCdnOf()`）。リトライでは、前回の
`outputRegion`のバケットを`CHECKPOINT_BUCKET`として渡し、チェックポイントをそこから読ませる。

EC2のAPIは常にリージョンを明示して呼ぶ（`ec2ClientFor(region)`）。起動したリージョンは
`JobRecord.workerRegion`に記録し、terminateはそのリージョンへ、タグでの探索
（`findJobInstances()`・`listTaggedInstances()`）は`workerRegions()`（`config.ts`）の
全リージョンを走査する。

`CreateFleet`が実際に確保したインスタンスタイプ・AZは `result.Instances[0]` から
そのまま取得でき、追加の`DescribeInstances`呼び出しは不要。`JobRecord.instanceType`/
`.availabilityZone`として記録する（`jobs.ts`の`updateJobInstance()`）。これは録画品質の
分析・運用調査用の内部データで、ユーザー向けAPI（`GetJobResponse`）には含めない。

コスト推定（Issue #60）用に、**Spot単価だけは`CreateFleet`のレスポンスに含まれない**ため
`fetchSpotPrice()`が`DescribeSpotPriceHistory`を1回だけ引いて
`JobRecord.spotPricePerHour`へ記録し、`sfn/launch.ts`が`markJobLaunched()`で
`JobRecord.launchedAt`（課金起点）を記録する。**単価の取得に失敗しても録画ジョブは
落とさない**（nullへ縮退）、**`launchedAt`は既に値があれば書き換えない**（条件付き更新、
理由は[`0021`](../../../docs/decisions/0021-cost-estimation-side-data-never-fails-the-job.md)）。

## 2. ワーカー起動スクリプト（UserData, `ec2.ts` の `buildUserData()`）

ベースの Launch Template（AMI/IAM/SGはCDK側で固定）に対し、ジョブ固有のUserDataのみを
持つ新しいバージョンを`CreateLaunchTemplateVersion`で作成してから`CreateFleet`する。
UserDataスクリプトがやること:

- `systemctl disable --now ecs`（ECS最適化AMIをプレーンなdockerホストとして使う）
- `trap 'shutdown -h now' EXIT`（どこで失敗しても必ずインスタンスを終了させる）
- ECRログイン → pull → `docker run`（`--log-opt awslogs-stream=${jobId}`）。ECRのログイン先は
  イメージのレジストリから導く（`ecrRegionOf()`）——GPUのフォールバック先（Issue #296）では
  そのリージョンのレプリカからpullするが、`AWS_DEFAULT_REGION`・awslogs・ワーカーの
  `AWS_REGION`は一次リージョンのままにする（出力・タイトル資産のバケットだけ起動先のものを渡す、
  Issue #313）
- コンテナ起動前段階で失敗したら`aws stepfunctions send-task-failure`で即時通知

> **この3点はいずれも事故を経て入れた対策で、消すと再発する**。理由は
> [`docs/decisions/0019`](../../../docs/decisions/0019-userdata-ecs-agent-off-and-bootstrap-failure-notification.md)。

`-e KEY=VALUE`として埋め込む環境変数の値（`taskToken`含む）はすべて`shellEscape()`で
単一引用符に括ってからスクリプトへ差し込む（入口検証をすり抜けた値が来ても
コマンドインジェクションへ変換されない多層防御、Issue #127 SEC-1）。
