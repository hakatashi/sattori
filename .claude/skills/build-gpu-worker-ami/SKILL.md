---
name: build-gpu-worker-ami
description: GPU描画必須タイトル(th06nc等、Issue #241)の録画に使うEC2カスタムAMI(NVIDIA GRIDドライバ・nvidia-container-toolkit導入済み)を構築し、CDKのLaunch Templateへ反映する手順。「GPU AMIを作り直して」「GRIDドライバを更新したい」「th06ncのインスタンスが起動しない」等で使う。都度UserDataでドライバを入れる方式ではなく事前構築AMIを固定参照する設計のため、更新頻度は低いが手順を誤るとth06ncの全ジョブが起動失敗する。必ずこの手順に従うこと。
---

# GPU用カスタムAMIの構築（Issue #241）

th06nc等のGPU描画必須タイトルは、CPU系ワーカー（Amazon Linux 2023、SSMパラメータで
動的解決）とは別に、**NVIDIA GRIDドライバ・nvidia-container-toolkitを事前導入した
カスタムAMIを1回だけ構築し、CDKのLaunch Templateへ固定参照する**方針を採っている
（都度UserDataでドライバをインストールする方式は、録画1本あたり数分〜十数分の
恒常的な追加起動時間が乗るためコスト・体感の両面で不利、
[`decisions/0046`](../../../docs/decisions/0046-gpu-ec2-instance-and-fixed-ami.md)）。

このSkillは低頻度の運用作業（ドライバ更新・OSパッチ適用等が必要になったときだけ）で、
通常のデプロイフロー（`deploy-sattori` skill）とは呼び出されるタイミングが異なるため
独立させてある。

## 0. 前提

- 対象リージョン: `eu-south-2`（本番）。検証は別リージョン（us-west-2等、G系スポット
  クォータの都合）で行ってもよいが、**最終的なAMIはeu-south-2で作成すること**
  （AMIはリージョンをまたいで直接使えない）。
- g6f.xlargeのG系スポット/オンデマンドクォータが確保されていること
  （`aws service-quotas get-service-quota --region eu-south-2 --service-code ec2
  --quota-code L-3819A6DF`、touhou-recorder reports/81 §1）。

## 1. 一時インスタンスの起動

ベースAMI（Ubuntu 24.04、NVIDIAドライバ無し）からg6f.xlargeを起動する。
`aws ec2 describe-instance-type-offerings --region eu-south-2 --location-type
availability-zone --filters Name=instance-type,Values=g6f.xlarge`でg6f.xlargeが
提供されるAZを確認してから起動すること。

## 2. NVIDIA GRIDドライバの導入

g6fはvGPU（仮想GPU）であり、通常のNVIDIAデータセンタードライバでは
`probe with driver nvidia failed with error -1`で失敗する
（touhou-recorder reports/81 §3）。**AWS配布のGRID（vGPU）ドライバを使うこと**。

**【重要】このバケットへのS3アクセスにはワーカーIAMロールの権限が無い**
（`AccessDenied`になる）。バケットポリシーは`ListObjectsV2`を拒否し`GetObject`を
`--no-sign-request`でのみ許可しているため、`aws s3 ls`/`cp`ともに`--no-sign-request`
を付けること。

```bash
# 既存のデータセンタードライバが入っていれば削除（holdされているので
# --allow-change-held-packagesが要る）
sudo apt-get -y --allow-change-held-packages remove --purge \
    'nvidia-driver-*' 'nvidia-dkms-*' 'libnvidia-nscq' 'nvidia-fabricmanager'

# AWS配布のGRIDドライバ。バケットはパブリックだが--no-sign-requestが必須
# （IAMロールの認証情報を使うとAccessDeniedになる、2026-09-12実機確認）。
aws s3 ls s3://ec2-linux-nvidia-drivers/latest/ --no-sign-request
aws s3 cp s3://ec2-linux-nvidia-drivers/latest/NVIDIA-Linux-x86_64-*-grid-aws.run /tmp/grid.run --no-sign-request
sudo sh /tmp/grid.run --silent --dkms
```

導入後、`nvidia-smi`で`NVIDIA L4-3Q`（3072 MiB、vGPUプロファイル。インスタンスタイプ
によりスライスサイズが変わる——g6f.2xlargeなら`L4-6Q`）のように認識されることを
確認する。

### 2.1 【重要・2026-09-12実機で新規判明】`nouveau`ドライバとの競合

素のUbuntu 24.04 AMIではOSSの`nouveau`ドライバが起動時に先にGPU（vGPU）を掴んで
おり、`nvidia`ドライバのカーネルモジュール自体はロードされるのに実際のデバイスへ
アタッチできず、`nvidia-smi`が`No devices were found`を返す。
`dmesg | grep -i nouveau`で`nouveau 0000:xx:00.0: vGPUs are not supported`が
出ていればこの症状。touhou-recorderでのus-west-2構築時のレポートには記載が無い
（ベースAMI・カーネルバージョンの違いによる可能性がある）。

```bash
echo 'blacklist nouveau' | sudo tee /etc/modprobe.d/blacklist-nouveau.conf
echo 'options nouveau modeset=0' | sudo tee -a /etc/modprobe.d/blacklist-nouveau.conf
sudo update-initramfs -u
sudo reboot
```

再起動後、`nvidia-smi`が正常にGPU情報を表示することを確認してから次のステップへ
進むこと。

## 3. nvidia-container-toolkitの導入

`docker run --gpus all`でコンテナへGPUを渡せるようにする。

```bash
distribution=$(. /etc/os-release; echo $ID$VERSION_ID)
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/$distribution/libnvidia-container.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit docker.io
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

動作確認（`nvidia-smi`入りの検証コンテナが通ることを確認する）:

```bash
docker run --rm --gpus all nvidia/cuda:12.6.0-base-ubuntu24.04 nvidia-smi
```

## 4. Xorg関連の動作確認

`worker/recording/gpu_display.py`が使う`nvidia-xconfig`が使えることを確認する。

```bash
which nvidia-xconfig
nvidia-xconfig --query-gpu-info
```

出力に`PCI BusID`の行があることを確認する。フォーマットが
`worker/recording/gpu_display.py`の`_query_bus_id()`のパース想定と食い違う場合は、
そちらの実装を実機の出力に合わせて修正すること。

## 5. AMI化

動作確認が済んだら一時インスタンスをAMI化する。

```bash
aws ec2 create-image --region eu-south-2 \
  --instance-id <一時インスタンスのID> \
  --name "sattori-worker-gpu-YYYYMMDD" \
  --description "NVIDIA GRIDドライバ+nvidia-container-toolkit導入済み(Issue #241)" \
  --no-reboot
```

`no-reboot`はAMI化中もインスタンスを起動したままにするオプション（ファイルシステムの
整合性はやや落ちるが、動作確認済みの状態を変えずに済む）。心配なら`--reboot`
（デフォルト）でスナップショット前に再起動させてもよい。

## 6. CDKへの反映

`infra/lib/sattori-stack.ts`の`gpuWorkerAmiId`コンテキスト値を新しいAMI IDへ更新する
（`cdk.json`にコミットする運用、詳細は`infra/README.md`）。

```bash
# cdk.jsonのcontext.gpuWorkerAmiIdを更新してからコミット
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm --filter @sattori/infra synth  # 構文確認
pnpm run deploy
```

**AMI更新後は必ず`worker-gpu`イメージ（`worker/Dockerfile.gpu`）の再ビルド・再pushも
行うこと**（`deploy-sattori` skill）。AMI側のドライババージョンとコンテナ内で期待する
ユーザースペースライブラリのバージョンが食い違うと、Xorg/DXVKが起動しない可能性がある
（`worker/docs/titles/th06nc.md`）。

## 7. 一時インスタンスの終了

AMI化が完了したら、検証用の一時インスタンスは必ず終了する（課金停止）。

```bash
aws ec2 terminate-instances --region eu-south-2 --instance-ids <一時インスタンスのID>
```

## 8. 実機確認

CDKデプロイ後、実際にth06ncのジョブを1本投入し、`/admin`でインスタンスタイプが
`g6f.xlarge`であること、CloudWatch Logsで以下が確認できることを確かめる:

- `nvidia-xconfig --query-gpu-info`によるBusID解決ログ
- Xorg起動ログ（エラー無し）
- `WINEDLLOVERRIDES`が効いている（DXVKが使われている）ことを示すwineログ

## 関連

- ワーカーイメージのビルド・push全体の流れ → `deploy-sattori` skill
- GPU描画の実装（Xorg起動・BusID解決・xrandr） → `worker/recording/gpu_display.py`
- th06nc固有の技術的背景 → `worker/docs/titles/th06nc.md`
- 採用理由・トレードオフ → [`decisions/0046`](../../../docs/decisions/0046-gpu-ec2-instance-and-fixed-ami.md)
