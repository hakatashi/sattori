# クラウド検証・デプロイ仕様

このドキュメントでは、AWS (EC2 Spot / ECS) および GCP 上での実機検証・デプロイ環境の仕様と運用ルールをまとめます。

> **GCPについて**: GCPでの検証はフェーズ15のみで、以降はAWSに一本化している。検証用GCPプロジェクト `<GCP_PROJECT_ID>` は**2026-10-14にプロジェクトごと削除済み**。`cloud/terraform/cloudrun/`・`cloud/terraform/gce/` は当時の記録として残っているだけで、そのままでは適用できない（GCPで再検証する場合はプロジェクトの新規作成から必要）。

## クラウド環境の設計原則

### 1. インスタンス選定
- **4 vCPUが実用上の下限**: 2 vCPU（`.large` 帯）は描画・エンコード性能が著しく不足し、重複フレーム率が悪化します。各タイトルごとの推奨スペック（4 vCPU / 8 vCPU / 16 vCPU / GPU）は [docs/titles/](docs/titles/) を参照してください。
- **AWS推奨ファミリー**: AWSでは `c7i` 系（新世代インテル）が同価格帯の旧世代や高クロック特化系と比べて重複フレーム率・価格ともに最も良好です。
- **Spot Fleet運用**: 複数AZにまたがるSpot Fleet（`AllocationStrategy: lowestPrice`）を使用することで、最安AZが自動選択され安定して低コスト運用が可能です。

### 2. リージョン特性
- **eu-south-2 (ミラノ)**:
  - Spot価格が比較的安価で本番同等の録画品質が得られます（`c7i.xlarge` 約$0.046〜0.048/h）。
  - Ubuntu 24.04環境のaptには `awscli` パッケージがないため、公式zipインストーラ（`unzip` パッケージ必要）を用いて導入します。
- **us-west-2**: GPUインスタンスのクォータやリソース確保用として使用実績があります。

### 3. コスト・Egress対策
- 大量の動画ダウンロードを行う場合、ネットワーク転送量（Egress）がコスト要因となります。AWS運用の際は **CloudFrontの永年無料枠 (1TB/月)** を活用します。

### 4. Docker・コンテナ運用
- **ボリュームマウントの徹底**:
  - `docker run --rm` でホストボリュームをマウントせずに長時間録画を行うと、コンテナ終了やSSH切断時に成果物が失われます。
  - 長時間検証時は `-v` によるホストディレクトリのマウント、`nohup` によるバックグラウンド実行、ポーリングによる完了監視を徹底してください。
- **ルートボリュームサイズ**:
  - Amazon Linux 2023最新AMI等はデフォルトルートボリュームが小さいため（2GiB等）、起動時に `--block-device-mappings` で40GiB以上に拡張します。
- **個別タイトルのDockerfile**:
  - 単一タイトルの実機検証を行う際は、全タイトル入りの巨大イメージ（`Dockerfile.multigame`、7GB超）ではなく、対象タイトル単体のDockerfile（`Dockerfile.th08`、`Dockerfile.th20` 等）を使用してpull時間を短縮します。

### 5. 常駐デーモンの競合対策
- **ECS最適化AMIの注意点**:
  - ECS最適化AMIを単体EC2として使用する場合、常駐するECSエージェントがx11grabキャプチャと競合して重複フレームを誘発するため、必ず `systemctl disable --now ecs` を実行して停止します。

### 6. 切り分け検証
- 短時間で動作確認を行う場合は、`scripts/25` の `--record-seconds N` や `--no-audio` を活用することで1試行を数分に短縮できます。

## 参照レポート・実装

- `cloud/docker/`
- `cloud/terraform/`
- `reports/15_phase15_cloud_deployment_gcp.md`
- `reports/16_phase16_cloud_deployment_aws.md`
- `reports/17_phase17_instance_type_and_spot_fleet_optimization.md`
- `reports/20_phase20_sattori_production_ecs_agent_contention.md`
- `reports/27_phase27_th08_alternative_instance_type_verification.md`
- `reports/42_phase42_eu_south_2_region_migration_verification.md`
- `reports/46_phase46_th20_aws_eu_south_2_instance_spec_verification.md`
