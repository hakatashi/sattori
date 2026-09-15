# th06nc（東方紅魔郷: New Classic）録画対応のGPUインフラ構築とE2E検証

- **検証日**: 2026-09-12
- **対象**: th06nc(東方紅魔郷: New Classic、Issue #241)のGPU用カスタムAMI構築・
  CDKデプロイ・タイトル資産アップロード・本番環境でのE2E検証(720p/1080p)
- **環境**: eu-south-2（本番リージョン）、GPU AMI構築はg6f.2xlarge（一時インスタンス、
  g6f.xlargeのスポット枯渇のため代替）、本番録画ジョブはg6f.xlarge（`GPU_CANDIDATE_
  INSTANCE_TYPES`）
- **結論**: GPU用カスタムAMI構築・CDKデプロイ・タイトル資産アップロードはすべて成功。
  ローカル（GPU無し、Xvfb+llvmpipe）でのMOD機能検証（ローダーロック回避・メニュー
  操作シーケンス・スコア監視）も成功。**本番相当のE2E録画検証（720p/1080p）は
  eu-south-2のg6f.xlargeスポット在庫が長時間枯渇していたため未完了**——これは
  sattori側の実装の不具合ではなくAWS側の在庫状況によるもの。在庫回復後に再試行が必要。

## 目的

Issue #241（th06nc録画対応）の実装完了後、以下を実機で確認する:

1. GPU用カスタムAMI（NVIDIA GRIDドライバ・nvidia-container-toolkit導入済み）が
   実際に構築でき、`recording/gpu_display.py`が想定する`nvidia-xconfig`の出力
   フォーマット・Xorg起動・xrandr CRTCモード切り替えが実機で機能すること。
2. 新規に書き起こした`mods/th06nc_replay_autoplay/dllmain.cpp`（touhou-recorder
   側の診断機能満載の実装から、ローダーロック対策のロジックだけを残してシンプル化
   した本番向け実装）が、ローダーロックのデッドロックを起こさずメニュー操作
   シーケンスを完走すること。
3. タイトル資産（ゲームデータ・DXVK配置済みWINEPREFIX・MODビルド成果物）のS3
   アップロードから、ワーカーによる展開・録画までのパイプライン全体が動くこと。

## 方法

### GPU用カスタムAMIの構築（`build-gpu-worker-ami` skill）

eu-south-2でg6f.xlargeのスポットインスタンス起動を試みたが、**全AZ（a/b/c）で
約20分間（60回×20秒間隔のリトライすべて）`UnfulfillableCapacity`が続いた**ため、
AMI構築自体はg6f.2xlarge（同じくG系スポットクォータ8vCPU内に収まる）で代替した。
AMIはインスタンスタイプに依存しないため、g6f.2xlargeで構築したAMIをg6f.xlarge
向けLaunch Templateで使うことに支障はない。

1. Ubuntu 24.04ベースAMIからg6f.2xlargeを起動。
2. NVIDIA GRIDドライバ（`NVIDIA-Linux-x86_64-595.91.07-grid-aws.run`、S3
   `ec2-linux-nvidia-drivers`バケットから`--no-sign-request`で取得。ワーカー
   IAMロールにはこのバケットへのアクセス権限が無いため、通常のcredential付き
   アクセスは`AccessDenied`になる——このバケットはパブリックだがListObjectsは
   拒否、GetObjectは`--no-sign-request`でのみ許可されている）をインストール。
3. **【新知見】素の状態ではOSSの`nouveau`ドライバが先にGPUを掴んでおり、
   `nouveau 0000:31:00.0: vGPUs are not supported`のログとともに`nvidia`
   ドライバがデバイスへアタッチできず`nvidia-smi`が`No devices were found`を
   返す**。`/etc/modprobe.d/blacklist-nouveau.conf`で`nouveau`をブラック
   リストし再起動することで解決した（touhou-recorder reports/81には無い、
   今回のAWS実機構築で新たに判明した手順）。
4. `nvidia-container-toolkit`導入・`docker run --gpus all`でのGPU認識を確認。
5. Xorg + `nvidia-xconfig --query-gpu-info`によるBusID解決、`AllowEmptyInitial
   Configuration`設定でのヘッドレスXorg起動、`xrandr`によるCRTCモード変更を確認。
6. 動作確認後、一時インスタンスを`aws ec2 create-image`でAMI化
   （`ami-062b165b8b855e6fe`）。

### ローカルMOD機能検証（GPU不使用、Xvfb+llvmpipe）

`verify-recording-locally` skillの対象外（th06ncはGPU専用）だが、AMI構築中の
待ち時間を使い、新規に書き起こしたMODの**機能面**（ローダーロック回避・シーケンス
完走）だけをこのマシン（自宅ワーカー機、`sattori-home-worker`停止済みを確認済み）の
Xvfb+llvmpipe環境で検証した。720p（`th06.env.720p`）・`TH06NC_TIME_SCALE=7`
（メニュー操作の待ちを7倍に伸ばす、GPU無しの低fps環境向け）で`th6_07.rpy`相当の
短尺リプレイを実行。

### CDKデプロイ・タイトル資産アップロード

1. `infra/cdk.json`の`context.gpuWorkerAmiId`に上記AMI IDを設定し、
   `pnpm run deploy`（IAM変更を含むため`--require-approval never`）でデプロイ。
   `WorkerGpuRepo`（ECR）・`GpuWorkerLaunchTemplate`が作成された。
2. `worker/Dockerfile.gpu`から`sattori-worker-gpu`イメージをビルドし、ECRへpush。
3. touhou-recorderの`games/th06nc/`・`prefixes/th06nc-wined3d-gl/`
   （DXVK配置済み）を`worker/games/th06nc/`・`worker/prefixes/th06nc-wined3d-gl/`
   へrsyncし、`steam_api64.dll`をth06nc用スタブで上書き。tar化してS3
   `titles/th06nc/assets.tar.gz`へアップロード（1.3GB）。

### E2E検証（Web API経由）

ブラウザUIの代わりに`POST /uploads` → S3 PUT → `POST /magic-links` →
（DynamoDBから`jobId`取得）→ `POST /jobs/{jobId}/start` → `GET /jobs/{jobId}`
ポーリング、という手順をAPIで直接再現した。720p（`th6_05.rpy`、Hard・6分13秒、
`th06ncHighResolution: false`）・1080p（`th6_12.rpy`、Extra・6分55秒、
`th06ncHighResolution: true`）の2本を投入した。

## 結果

| 項目 | 結果 |
| --- | --- |
| GPU用カスタムAMI構築（GRIDドライバ・nvidia-container-toolkit・Xorg・xrandr） | **成功** |
| ローカルMOD機能検証（ローダーロック回避・メニュー操作シーケンス完走・スコア監視） | **成功**（"sequence complete"到達、`ScoreMonitor: score=390`で内部スコアの増加を確認） |
| CDKデプロイ（`WorkerGpuRepo`・`GpuWorkerLaunchTemplate`作成） | **成功** |
| `worker-gpu`イメージのビルド・ECR push | **成功** |
| タイトル資産のS3アップロード（1.3GB） | **成功** |
| E2E録画（720p、`th6_05.rpy`） | **失敗**（EC2 Fleet起動が10回リトライすべて`UnfulfillableCapacity`） |
| E2E録画（1080p、`th6_12.rpy`） | **失敗**（同上） |

両ジョブとも`JobRecord.instanceId`・`instanceType`・`workerKind`が`null`のまま
`status: failed`・`errorCode: retries_exhausted`になった。Step Functions実行履歴の
`TaskFailed`イベントで、`launchRecordingInstance()`が全AZ・全リトライで
`UnfulfillableCapacity: Unable to fulfill capacity due to your request
configuration.`を返していたことを確認した。手動での`CreateFleet`呼び出し
（`GpuWorkerLaunchTemplate`使用）でも同じエラーが再現し、コード側の問題ではなく
AWS側の在庫状況によるものと判断した。

## 考察・既知の限界

- **eu-south-2のg6f.xlargeスポット在庫は、この検証を行った時間帯（2026-09-12
  昼頃UTC）に長時間（AMI構築時の約20分に加え、本E2E検証時も継続）枯渇していた**。
  スポット価格履歴を見る限り異常な高騰は無く、純粋な容量不足と見られる。時間帯・
  曜日による変動がある可能性があり、今回の1回の観測だけでは「恒常的に取りにくい
  インスタンスタイプ」と結論づけることはできない。
- **本番相当のE2E録画検証（720p/1080pのフル尺録画、重複フレーム率・A/V同期・
  スコア一致の実測）はまだ完了していない**。在庫回復後に本レポートを更新するか、
  新しいレポートを追加すること。それまでは`worker/docs/titles/th06nc.md`・
  `docs/known-limitations.md`の該当記述を「実機E2E検証は未完了」のまま残す。
- ローカルMOD機能検証はGPU無し・llvmpipeのため、DXVK・GPU描画自体の検証には
  ならない（あくまでMODのロジック——入力注入・メニュー操作・スコア監視——が
  正しく動くことの確認に限定される）。GPU描画品質（重複フレーム率・fps安定性）は
  touhou-recorder reports/78〜81のローカルGPU実機・AWS実機（us-west-2）検証で
  既に確認済み。
- NVIDIA GRIDドライバが`nouveau`と競合してGPUを掴めない問題は、touhou-recorder
  側のレポート（us-west-2での構築）には記載が無かった新知見。AMIのベースOS・
  カーネルバージョンの違いによる可能性がある。`build-gpu-worker-ami` skillに
  追記済み。
