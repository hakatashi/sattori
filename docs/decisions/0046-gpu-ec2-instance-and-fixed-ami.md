# 0046. GPU描画必須タイトル向けにg6f.xlargeを新規導入し、AMIは事前構築したカスタムAMIを固定参照する

- **状態**: 有効
- **決定日**: 2026-09-12
- **対象**: infra / apps/api / worker
- **関連**: Issue #241、`docs/decisions/0002-ec2-launch-at-runtime-not-iac.md`、
  `docs/decisions/0016-ec2-fleet-instance-type-diversification.md`、
  touhou-recorder reports/78〜81

th06nc（東方紅魔郷: New Classic）はD3D11描画であり、既存9タイトルのXvfb+wined3d+
llvmpipe（ソフトウェア描画）では60fpsに遠く届かない。GPU（NVIDIA GRIDドライバ）+
DXVK（D3D11→Vulkan）の経路が必須で、そのために新たに`g6f.xlarge`インスタンスを
導入し、CPU系ワーカーとは異なりAMIを事前構築したカスタムAMIとして固定参照する。

## 背景

既存9タイトルはすべてXvfb+wined3d+llvmpipeで60fpsを達成できるが、th06ncはこの経路
では720pで9.1fps、1080pで5.1fpsしか出ない（touhou-recorder reports/78 §5）。
ローカル検証環境（AMD Radeon VII）でGPU描画による60fps達成を確認したが、プロセス
終了時のGPU VM破棄がdma_fence待ちで恒久的にハングする既知の問題（wined3d/DXVK
いずれでも発生、amdgpu固有の可能性が高い）があり、本番でこのGPUを使うのはリスクが
高いと判断した（reports/79・80）。そのため、本番はAWSのNVIDIA GPUインスタンスで
録画する方針とした。

インスタンスタイプ候補の実機検証（reports/80・81、us-west-2実施）の結果、
`g6f.xlarge`（NVIDIA L4の1/8スライス、4vCPU/16GiB）で720p/1080pともに実用品質
（重複フレーム率0.0〜0.4%）を達成できることを確認した。

GPU描画にはNVIDIA GRIDドライバ（vGPU用、通常のデータセンタードライバでは
`probe failed`になる）とnvidia-container-toolkitの導入が必要だが、これらは
インストールに時間がかかり（ドライバのダウンロード・DKMSビルド等）、ジョブ起動の
たびにUserDataで行うと録画1本あたり数分〜十数分の恒常的な追加起動時間が乗る。
コスト試算の結果、この追加時間のコスト（月$10〜16程度、録画本数に比例して悪化）
は、事前構築したカスタムAMIの保管コスト（月1〜2ドル程度、録画本数によらず固定）
より圧倒的に不利であることが判明した。

## 決定

- 候補インスタンスタイプに`g6f.xlarge`を新設する（`apps/api/src/ec2.ts`の
  `GPU_CANDIDATE_INSTANCE_TYPES`）。720p・1080pどちらの録画もこの1タイプで行う。
- **GPU描画必須タイトル向けのAMIは、CPU系ワーカー（SSMパラメータでECS最適化
  AL2023を動的解決）とは異なり、事前に1回手動構築したカスタムAMI
  （NVIDIA GRIDドライバ・nvidia-container-toolkit導入済み）を固定参照する**
  （`infra/lib/sattori-stack.ts`の`gpuWorkerAmiId`コンテキスト値、
  `GpuWorkerLaunchTemplate`）。AMI IDは`cdk.json`にコミットし、更新をgit履歴で
  追跡できるようにする。
- コンテキスト値が未設定のままCDK synthを実行すると例外を投げて失敗させる
  （誤ってCPU系AMIのままGPU系を起動する事故を防ぐため）。
- GPU用ワーカーイメージ（`worker/Dockerfile.gpu`）は`docker run --gpus all`
  （nvidia-container-toolkit）でホストのGPUをコンテナへ渡す。イメージ自体には
  NVIDIAドライバ本体を含めない。
- AMI構築手順は`build-gpu-worker-ami` skillに切り出す（低頻度の運用作業のため、
  通常のデプロイフロー`deploy-sattori` skillとは分離）。
- **1080p録画オプションもg6f.xlargeのまま提供する**（`packages/shared/src/
  highResolutionRecording.ts`）。touhou-recorder reports/81 §9.9.3の実測では
  1080pは本来g6f.2xlarge（8vCPU）が推奨——g6f.xlarge（4vCPU）では実効fpsが
  54.87まで悪化し重複フレーム率が7.9%まで増える——だが、eu-south-2のG系スポット
  クォータが現状8vCPU（g6f.xlarge換算で2台分の並列運用余地）であることを踏まえ、
  並列運用の余地を残す意味でユーザー判断でg6f.xlargeのまま提供する。

## 根拠

- GPU描画の必要性・DXVK採用の実測: touhou-recorder reports/78〜81。
- ローカルGPU（amdgpu）でのハング問題とAWS実機移行の判断根拠: reports/79・80 §4。
- g6f.xlargeでの720p/1080p実測（重複フレーム率、実効fps、A/V同期）: reports/81
  §8・§9.8・§9.9.3。
- 都度UserDataインストール vs 事前構築AMIのコスト比較: ユーザーへのコスト試算
  提示（録画1本あたり10〜15分の追加起動時間 vs AMI保管コスト月1〜2ドル）を経て
  カスタムAMI方式で確定。

## 採らなかった選択肢

- **都度UserDataでGRIDドライバをインストールする**: 既存の「AMIはCDKがSSM
  パラメータで動的解決する」という一貫性は保てるが、コスト・録画開始までの
  リードタイムの両面で不利なため見送った。
- **ローカルのAMD GPU（amdgpu）を本番で使う**: プロセス終了時のGPU VM破棄が
  恒久的にハングする問題があり、本番サービスでこのリスクを負うのは不適切と
  判断した（reports/79・80）。
- **g6f.2xlarge（8vCPU）を既定インスタンスにする**: 1080p録画の品質は
  g6f.xlargeより良いが、eu-south-2のG系スポットクォータ8vCPUの下では並列
  1台しか運用できなくなる。720p/1080pどちらもg6f.xlargeに統一することで
  並列2台の運用余地を残した。

## 影響範囲

- `apps/api/src/ec2.ts`（候補インスタンスタイプ・Launch Template・ECRイメージの
  GPU系分岐）、`apps/api/src/config.ts`（`workerGpuImage`・`gpuLaunchTemplateId`）。
- `infra/lib/sattori-stack.ts`（`workerGpuRepo`・`gpuWorkerLaunchTemplate`・
  `gpuWorkerAmiId`コンテキスト値）。
- `worker/Dockerfile.gpu`・`worker/recording/gpu_display.py`。
- `packages/shared/src/gpuRecording.ts`・`highResolutionRecording.ts`・`cost.ts`
  （`gpu-xlarge`価格帯）。
- AMI更新時は`build-gpu-worker-ami` skillの手順に従い、`worker-gpu`イメージの
  再ビルド・再pushをセットで行うこと（ドライババージョンの不一致でXorg/DXVKが
  起動しなくなるリスクがある）。
