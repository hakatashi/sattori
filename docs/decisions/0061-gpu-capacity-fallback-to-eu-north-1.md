# 0061. GPUワーカーはeu-south-2の容量不足時だけeu-north-1で起動する（価格では振り分けない）

- **状態**: 有効
- **決定日**: 2026-10-11
- **対象**: apps/api / infra / packages/shared / worker / apps/web
- **関連**: Issue #296、#288、#289、[`docs/reports/2026-10-11-gpu-capacity-eu-south-2-vs-eu-north-1.md`](../reports/2026-10-11-gpu-capacity-eu-south-2-vs-eu-north-1.md)、[`0001`](0001-region-eu-south-2-ses-us-east-1.md)・[`0046`](0046-gpu-ec2-instance-and-fixed-ami.md)・[`0056`](0056-gpu-vcpu-lease-and-queue.md)・[`0058`](0058-speedup-recording-on-gpu-instances.md)・[`0060`](0060-speedup-fallback-to-native-speed.md)

GPUジョブ（`requiresGpuRecording()`）の`CreateFleet`がeu-south-2で**Spot在庫の枯渇**
（`InsufficientInstanceCapacity`/`UnfulfillableCapacity`）により失敗したときだけ、同じLaunch
Lambdaの中でeu-north-1へ起動し直す。データ面は一切移さない。単一リージョン原則（0001）の
例外であり、**ワーカーの`AWS_REGION`をeu-north-1にしたり、CPU系ジョブを逃がしたりしないこと**。

## 背景

eu-south-2のg6f.2xlarge Spotは2026-09下旬から長期的に枯渇している。GPU必須の3タイトル
（th06nc・th15・th20）は等倍CPUへ落とせない（0060）ため、容量不足がそのまま失敗になる。
GPUはg6f.2xlarge固定（0058。g6f.xlargeは両リージョンとも在庫なし）で、eu-south-2内に
逃げ場が無い。

実機確認（10/9・10/11）では、同じ時間帯にeu-south-2の全AZが`InsufficientInstanceCapacity`、
eu-north-1bだけ起動できた。Spot配置スコアもeu-south-2が1、eu-north-1が9だった。

## 決定

- **リージョンの選び方**（`apps/api/src/ec2.ts`の`launchRecordingInstance`）: 常にeu-south-2を
  先に試す。GPUジョブで、エラーコードが`GPU_FALLBACK_TRIGGER_ERROR_CODES`に当たったときだけ
  eu-north-1でもう一度`CreateFleet`する。両方失敗したら、両方のエラーコードを含む例外を投げる
  （`handleFailure.ts`の容量不足判定・0060の等倍フォールバックがそのまま働く）。
  `VcpuLimitExceeded`/`MaxSpotInstanceCountExceeded`ではフォールバックしない。
- **リトライでもリージョンを固定しない**。毎回eu-south-2から試す。
- **データ面はeu-south-2のまま**。ワーカーへ渡す環境変数（`workerEnv.ts`）は変えず、
  `AWS_REGION`・awslogs・`send-task-failure`も一次リージョンを向く。変わるのはEC2を起動する
  リージョンと、ECRのpull元（レプリカ）・ログイン先だけ（`buildUserData`の`ecrRegionOf()`）。
- **フォールバック先に置くもの**（`SattoriGpuFallbackStack`、`infra/lib/sattori-gpu-fallback-stack.ts`）:
  VPC（g6f.2xlargeを提供する1a/1bのパブリックサブネットのみ・NATなし）、送信のみのSG、
  固定名のGPU Launch Template、ECRレプリカの受け皿。AMIは`copy-image`したもの
  （`cdk.json`の`gpuWorkerAmiIds`）。ECRは本体のレジストリ複製設定で自動複製する。
- **2スタック間にCloudFormation参照を張らない**。固定名（`infra/lib/gpu-fallback.ts`）で受け渡し、
  デプロイ順をフォールバック → 本体にする。サブネットはLaunch Lambdaがタグで実行時に引く。
  インスタンスプロファイルは本体が既存の`WorkerRole`に対して固定名で**追加**する。
- **リージョンを扱う処理**: `JobRecord.workerRegion`を記録し、terminate（`handleFailure`・
  `stopJob`）はそのリージョンへ、タグ検索・孤児掃除・GPU台帳の照合は全ワーカーリージョン
  （`config.ts`の`workerRegions()`）を走査する。`GetConsoleOutput`もリージョンを指定する。
- **GPU台帳（0056）は1本・上限32 vCPUのまま**。リージョン別に分けない。
- **コスト推定**（`packages/shared/src/cost.ts`）: 一次リージョン以外で動いたジョブに
  `interRegionTransfer`（$0.02/GB）を計上する。転送量はワーカーが記録するタイトル資産・
  生動画チェックポイントのサイズと出力サイズの合計。
- **検証用の上書き**: 管理設定`forceGpuFallbackRegion`で、GPUジョブを常にフォールバック先で
  起動できる（本番での実機検証用、AGENTS.md §3）。

## 根拠

Issue #296のコメント（2026-10-09時点の実測）による。

- **価格で振り分けると損益はほぼゼロか赤字**。5週間通算の単価差は$0.013/時、1件0.19時間なので
  1件あたり$0.008の節約に対し、リージョン間転送料は約$0.05/件で6倍になる。どちらが安いかも
  週単位で入れ替わる。出力バケットまでeu-north-1に置けば転送料はほぼ消えるが、最良でも年$30程度で、
  CloudFrontの2オリジン化・`JobRecord`への出力リージョン保持・タイトル資産の複製運用に見合わない。
- **容量不足時だけ逃がすなら、固定費は月$1〜2**（AMIスナップショット・ECRレプリカ）で、
  転送料は逃がしたジョブだけ（約$0.05/件）。5AZ分の在庫から確保でき、GPU必須ジョブの失敗回避
  として妥当。
- **リトライ時にリージョンを固定しないのは**、チェックポイントも出力も常にeu-south-2のS3にあり、
  固定しても得が無いため。固定すると、容量不足のジョブを逃がすという目的そのものを妨げる。
  eu-south-2を毎回先に試すので、チェックポイントの読み戻しが無料な側が自然に優先される
  （eu-north-1で再開した場合の読み戻し費用は$0.004〜0.012）。これはIssueコメントの推奨設計
  （チェックポイントありのリトライは同一リージョン固定）からの唯一の変更点。
- **台帳を1本のままにしたのは**、ADR 0056のロジックを変えずに済むため。両リージョン合計で
  32 vCPUを超えて同時に動かすことは当面無い。

## 採らなかった選択肢

- **価格で振り分ける**（出力もeu-north-1に置く／置かない）。上記の収支のとおり。再検討の目安は
  「GPU稼働が月100時間超、かつ$0.03/時以上の価格差が1か月以上続いたとき」。
- **何もしない**。GPU必須3タイトルの容量不足失敗が残る。
- **タイトル資産・出力バケットをeu-north-1へ複製する**。逃がすジョブの転送料（月$0.5程度）より
  複製の運用コストのほうが大きい。
- **`crossRegionReferences`で本体とフォールバックを繋ぐ**。本体はLaunch Template・サブネットを、
  フォールバックはインスタンスプロファイルを必要とし、循環する。
- **既存の`WorkerInstanceProfile`に固定名を付ける**。CloudFormation上は置き換えになり、
  実行中のワーカーを巻き込む。
- **GPU台帳をリージョン別に分ける**。同時実行を増やしたくなった時点で検討する。
- **On-Demandへ逃がす**。eu-north-1のg6f.2xlargeは$0.504/時でSpotの約5倍。

## 影響範囲

- フォールバック先のクォータは**8 vCPUのまま**（2026-10-11時点。申請と異なるOn-Demand枠が
  引き上げられた疑い、`docs/reports/2026-10-11-...`）。訂正されるまでは、フォールバック先で
  同時に動かせるのは1台だけ。
- GPU AMIを更新したら、両リージョンのAMI IDを更新する（`build-gpu-worker-ami` skill）。
- GPUイメージのpush後は、レプリカへの到着を確認してからデプロイする（`deploy-sattori` skill）。
- EC2を触る新しい処理を足すときは、`workerRegions()`か`JobRecord.workerRegion`でリージョンを
  決めること。リージョン未指定の`EC2Client`は一次リージョンしか見ない。
- 録画品質は、eu-north-1で実機検証してから本番で常用する（AGENTS.md §3）。
