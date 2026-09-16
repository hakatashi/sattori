# th15(東方紺珠伝)の本番E2E検証(未完了)——2件の既存バグを発見・修正、GPU用AMI再構築はXorg起動不能で断念

- **検証日**: 2026-09-17
- **対象**: th15録画対応(Issue #82)PRの本番AWS環境でのE2E検証(フロントエンド非公開のまま
  バックエンドのみデプロイ、`verify-recording-in-production` skill参照)。検証対象リプレイは
  `packages/replay-parser/test-fixtures/th15/th15_07.rpy`(Hard、全クリア、スコア417,201,130)
- **結論**: **th15のGPU E2E録画は未完了**。検証の過程で2件のsattori既存バグ
  (①`worker/Dockerfile.gpu`にwine32が無くth15(32bit)が起動できない、
  ②EC2 Launch Templateの`$Default`バージョンが永久固定されCDKでのAMI変更が反映されない)
  を発見し修正・本番反映した。GPU用カスタムAMIに32bit互換NVIDIAドライバを追加する試みは
  Xorg起動不能(`Need libwfb but wfbScreenInit not found`)という新たな問題を招き、
  th06ncへの影響を避けるため**旧AMI(32bit非対応)へロールバックして中断**した。

## 経緯

### 発見1: `worker/Dockerfile.gpu`にwine32が無くth15が起動できない

th06nc(64bit専用)向けに作られた`worker/Dockerfile.gpu`は`wine64`のみを導入しており、
32bitアプリであるth15を実行すると

```
it looks like wine32 is missing, you should install it.
wine: '/app/prefixes/th15-wined3d-gl' is a 32-bit installation, it cannot support 64-bit applications.
```

で即座に失敗する(録画パイプライン自体は正常に動くため、リトライを3回消費してから
`recording_failed`になる)。CPU系`worker/Dockerfile`と同様に`dpkg --add-architecture i386`
してwine32・32bit版Mesaパッケージを追加して解消した(**修正済み・コミット済み**)。

### 発見2: EC2 Launch Templateの`$Default`バージョンがCDKデプロイで更新されない

`apps/api/src/ec2.ts`の`launchRecordingInstance()`は`CreateLaunchTemplateVersion`の
`SourceVersion`に`"$Default"`を指定していたが、**CloudFormationの`AWS::EC2::LaunchTemplate`
はプロパティ変更のたびに新しいバージョンを作るだけで、`DefaultVersionNumber`は自動更新
しない**(`ModifyLaunchTemplate`の明示呼び出しが要る。CDK側にその仕組みは無い)。

このため、GPU用カスタムAMI(`gpuWorkerAmiId`)を新しい値へ変更して`cdk deploy`しても、
**スタック作成時点の最初のバージョン(`$Default`)が永久に使われ続け、実際のジョブ起動には
一切反映されない**という、th15に限らずCPU系ワーカーにも当てはまる既存バグが発覚した
(th06ncのAMIはこれまで一度も変更されたことが無かったため、$Defaultが偶然正しい値のまま
気づかれずに済んでいた)。

`SourceVersion: "$Default"` → `"$Latest"`に変更して解消した(**修正済み・コミット済み**、
`apps/api/src/ec2.ts`・`ec2.test.ts`)。

**注意**: この修正だけでは、修正が有効になる前に**古いコード**(`$Default`のまま)が既に
作っていた新しいバージョン(`$Latest`)が古いAMIのままという状態を引きずる
(「`$Latest`の汚染」)。今回はこれに気づかず1回無駄なジョブ実行をしてしまった
(`CreateLaunchTemplateVersion --source-version <正しいバージョン番号>`で明示的に
作り直すことで解消した)。今後同種の変更をする際は、デプロイ直後に
`aws ec2 describe-launch-template-versions --versions '$Latest'`で意図した内容に
なっているか確認すること。

### GPU用カスタムAMIへの32bit互換ドライバ追加(未完了・ロールバック済み)

th15(32bit)がGPU(NVIDIA GLX/Vulkan)を実際に使えるようにするため、touhou-recorder
reports/82の手順(`NVIDIA-Linux-x86_64-595.91.07-grid-aws.run --silent --dkms
--compat32-libdir=/usr/lib/i386-linux-gnu`)に沿って新しいAMI(`ami-08b3f94444612a932`、
以下「新AMI」)を構築した。

- 一時インスタンス(g6f.2xlarge、eu-south-2b、Spot)で構築。`nouveau`ドライバの競合は
  事前にblacklist設定・再起動で回避(build-gpu-worker-ami skillの既知の手順どおり)。
- インストーラの既知の癖(`--compat32-libdir`指定時、32bitライブラリが
  `/usr/usr/lib/i386-linux-gnu/`に誤配置される)も、`cp -a`での複製+`ldconfig`で対処。
  `libGLX_nvidia.so.0`等の32bit版NVIDIAライブラリの配置を確認済み。
- `nvidia-smi`・`docker run --gpus all nvidia/cuda:... nvidia-smi`・`nvidia-xconfig
  --query-gpu-info`はすべて正常動作を確認。

しかし、この新AMIを使って実際のth15ジョブ(GPU描画あり)を起動したところ、
**Xorgの起動自体が失敗する**新しい問題が発生した:

```
[   106.418] (EE) NVIDIA(0): Need libwfb but wfbScreenInit not found
[   106.442] (EE) AddScreen/ScreenInit failed for driver 0
```

同一のワーカーイメージ(`worker-gpu:latest`、wine32対応済み)を**旧AMI**で使った直前の
試行ではXorgが正常起動していたため、**この問題は新AMI(32bit互換ドライバ追加版)固有**と
切り分けられる。`--compat32-libdir`付きのインストールが、何らかの理由で64bit側の
Xorgドライバモジュール(または関連コンポーネント)を壊した可能性が高いが、
**根本原因は未特定**。

この状態のままではth06nc(新AMIを共有する)も巻き込まれるリスクがあるため、
`gpuWorkerAmiId`を**旧AMI(`ami-062b165b8b855e6fe`、th06ncで動作実績あり)へロールバック**
して`cdk deploy`済み。新AMI自体はAWS上に残したまま(`ami-08b3f94444612a932`、次回調査用)。

## 副次的に確認できたこと(発見1修正後の実機ログより)

wine32修正後の初回試行(旧AMI、GPU無し=llvmpipeフォールバック相当の状態と推定)で、
MOD注入・メニュー自動操作・スコア監視(`ScoreMonitor: started`)・録画開始までは
正常に完走することを確認した。ただしこの試行はGPU未使用状態のため、総録画時間2799.9秒
(理論値2013.6秒に対し+39%)・重複フレーム率37.8%(閾値30%超過)と、ローカル検証
(+1.2%)より大幅に悪化していた。CPU使用率も録画中ずっと約75%(8vCPU中6vCPU相当)で
高止まりしており、ソフトウェアレンダリングへのフォールバックが疑われる
(GPU用インスタンス上でGPUが実際に使われていない状態での録画のため、この数値自体は
th15の本番品質の判断材料にはならない)。

## 未解決の課題(次回への引き継ぎ)

1. **新AMIでのXorg起動失敗(`libwfb`)の根本原因調査**。候補:
   - `--compat32-libdir`付きインストールが64bit側のXorgモジュール配置に副作用を
     与えていないか(`/usr/lib/xorg/modules/`配下の全ファイルを旧AMIと比較する)。
   - `xserver-xorg-core`等のバージョンが新AMI構築時点(2026-09-17)と旧AMI構築時点
     (th06nc構築時、2026-09-12)で異なっていないか(Ubuntu 24.04のセキュリティ更新で
     ABIが変わった可能性)。
   - GRIDドライバの`.run`インストーラに`--compat32-libdir`を付けない場合(素の
     `--silent --dkms`のみ)でも同じ問題が起きるか切り分ける。
2. 上記が解決したら、`gpuWorkerAmiId`を新AMIへ再度切り替え、`$Latest`の内容を
   `aws ec2 describe-launch-template-versions --versions '$Latest'`で確認したうえで
   th15のフル尺(Hard・Extra)E2E録画を実施し、GPU使用時の重複フレーム率・fps目視確認
   ([`docs/titles/th15.md`](../../worker/docs/titles/th15.md)参照)を行うこと。
3. **本レポート作成の過程でLaunch Templateのバージョンを大量に消費した**
   (`$Latest`が130番台まで進んでいる)。実害は無いが、不要なバージョンの整理
   (`DeleteLaunchTemplateVersions`)を検討してもよい。
4. worker-gpuイメージ(`:latest`)は既にwine32対応版がpush済みのため、**次にth06ncの
   ジョブが実行される際はこの新しいイメージを使う**。追加パッケージのみで既存機能を
   削除していないため影響は無いと考えられるが、次回th06ncジョブの結果を一度確認する
   ことを推奨する。

## 環境

- eu-south-2、Spot、g6f.xlarge/g6f.2xlarge(`GPU_CANDIDATE_INSTANCE_TYPES`)。
- 検証中、g6f系のSpotキャパシティが断続的に枯渇しており(`InsufficientInstanceCapacity`)、
  ジョブ起動自体が複数回失敗した(sattori側の不具合ではない)。
