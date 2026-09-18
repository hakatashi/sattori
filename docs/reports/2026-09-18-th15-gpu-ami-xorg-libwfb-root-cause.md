# th15 GPU用AMIのXorg起動不能(`Need libwfb`)の根本原因調査——AMIではなくdocker runのマウント方法が原因

- **検証日**: 2026-09-18
- **対象**: `docs/reports/2026-09-17-th15-production-e2e-attempt.md`で未解決だった
  Xorg起動不能(`Need libwfb but wfbScreenInit not found`)の根本原因調査(Issue #82、PR #264)
- **環境**: **us-west-2**(本番eu-south-2への影響を避けるため)。一時インスタンス
  (`g6f.xlarge`、us-west-2a、Spot、`i-0632eeab7f2f2aa4c`、検証後terminate済み)、
  ベースAMI`ami-04678417fc39d7171`(Ubuntu 24.04 20260904)
- **結論**: **原因はGPU用カスタムAMI(ホスト)側の構築手順ではなく、
  `apps/api/src/ec2.ts`の`docker run`が付与するマウント
  `-v /usr/lib/xorg/modules:/usr/lib/xorg/modules:ro`だった**。ディレクトリ丸ごとの
  bind mountはコンテナ自身の`xserver-xorg-core`由来モジュール(`libwfb.so`等)を隠して
  しまい、ホスト側にNVIDIAドライバが置いたファイルだけに置き換わる。NVIDIA用ファイル
  だけを個別にマウントする方式へ修正し(`docs/decisions/0052`)、us-west-2上の実際の
  コンテナ実行で解消することを確認した。**この不具合はth15固有でもAMI固有でもなく、
  GPU系ジョブ全体(th06ncも含む)に共通するコード上の問題**。

## 経緯

前回レポート(`2026-09-17-th15-production-e2e-attempt.md`)の時点での仮説は
「`--compat32-libdir`付きでのNVIDIA GRIDドライバインストールが、ホストの64bit側Xorg
モジュール配置に副作用を与えた」だった。この仮説をeu-south-2本番環境に影響を与えずに
検証するため、us-west-2で同じ手順を再現した。

### 1. ベースライン再現(compat32無し)は問題なし

us-west-2の一時インスタンス(Ubuntu 24.04ベースAMI)で、`build-gpu-worker-ami` skillの
手順どおりnouveau無効化→NVIDIA GRIDドライバ(`595.91.07-grid-aws.run --silent --dkms`、
compat32無し)→`xserver-xorg-core`等の導入、の順に実施したところ、**ホスト上で直接
Xorgを起動する分には問題なく起動した**(`xdpyinfo`成功)。

### 2. compat32付きでも、ホスト上で直接起動する限り問題は再現しない

同じホストで`nvidia-uninstall`→`dpkg --add-architecture i386`→
`--compat32-libdir=/usr/lib/i386-linux-gnu`付きでドライバを再導入し直しても、
**ホスト上で直接Xorgを起動する限りは正常に起動した**(`xserver-xorg-core`が既に
入っている状態・完全にクリーンな状態から入れ直した場合のどちらでも再現せず)。
この時点で「AMI(ホストOS)構築手順自体には問題が無い」ことが強く示唆された。

### 3. 【転換点】Xorgは実際にはホストではなくDockerコンテナ内で起動している

`worker/Dockerfile.gpu`を確認したところ、**Xorgを含むXサーバ関連パッケージ
(`xserver-xorg-core`等)はワーカーのDockerイメージ自身が導入しており、`Xorg`プロセスは
コンテナ内で起動する**設計だった。ホストのNVIDIA GRIDドライバは
`docker run --gpus all`(nvidia-container-toolkit)経由でコンテナへ渡される。
つまり、これまでの「ホスト単体でXorgを直接起動する」検証は、**本番の実行トポロジ
(ホストのドライバをコンテナへマウントして使う)を再現できていなかった**。

`apps/api/src/ec2.ts`のGPU系`docker run`フラグには
`-v /usr/lib/xorg/modules:/usr/lib/xorg/modules:ro`が付与されていた。これは
ホストの`/usr/lib/xorg/modules`ディレクトリを**丸ごと**コンテナの同じパスへ
かぶせるbind mountである。

### 4. コンテナでの再現実験

us-west-2の同じホストに`nvidia-container-toolkit`・`docker.io`を導入し、
`docker run --gpus all --ipc=host -e NVIDIA_DRIVER_CAPABILITIES=all ... -v /usr/lib/xorg/modules:/usr/lib/xorg/modules:ro`
(本番の`ec2.ts`と同じフラグ)で`ubuntu:24.04`コンテナを起動し、コンテナ内で
`xserver-xorg-core`を導入しようとしたところ、**ホストのディレクトリが読み取り専用で
マウントされているため、コンテナ内へのインストール自体が
`Read-only file system`で失敗する**ことをまず確認した。

そこで、コンテナを`-v`無しで起動して`xserver-xorg-core`をコンテナ**イメージ自身**の
レイヤーへ導入した後、ホストの`/usr/lib/xorg/modules`をディレクトリごとマウントする
本番と同じ構成で起動し直したところ、コンテナ内のXorgログで
**`libwfb`関連のエラーは確認できなかったが**、原因を切り分けるため、まず
「ホストに`xserver-xorg-core`が入っていない(NVIDIAドライバのみ)状態」を作った
(この時点のホスト`/usr/lib/xorg/modules`には`drivers/nvidia_drv.so`と
`extensions/libglxserver_nvidia.so*`の2ファイルのみが存在し、`libwfb.so`等の
標準モジュールは存在しない——`xserver-xorg-core`をホストから完全にpurgeしたため)。
この状態でディレクトリ丸ごとマウントを使うと、コンテナ内Xorgが
**`(EE) NVIDIA(0): Need libwfb but wfbScreenInit not found`で本番と同一のエラーを
再現した**。

### 5. 修正方法の確認

マウントを、ホストの個別ファイル
(`/usr/lib/xorg/modules/drivers/nvidia_drv.so`・
`/usr/lib/xorg/modules/extensions/libglxserver_nvidia.so*`)だけをそれぞれ
`docker run -v <file>:<file>:ro`で個別マウントする方式に変えたところ、
コンテナ自身の`xserver-xorg-core`由来モジュール(`libwfb.so`含む)を維持したまま
NVIDIAドライバのファイルだけが追加され、**Xorgが正常に起動した**(`xdpyinfo`成功、
ログに`Loading /usr/lib/xorg/modules/libwfb.so`→`Module wfb: vendor="X.Org Foundation"`
を確認)。

### 6. nvidia-container-toolkitの自動マウント範囲の確認

`-v`マウントを一切付けない状態でも`NVIDIA_DRIVER_CAPABILITIES=all`により
`libnvidia-glcore.so`等の多数のユーザースペースライブラリはコンテナへ自動マウント
されることを確認したが、`find / -iname 'nvidia_drv.so' -o -iname
'libglxserver_nvidia*'`は何もヒットせず、**Xorg用の`nvidia_drv.so`・
`libglxserver_nvidia.so`はnvidia-container-toolkitの自動マウント対象に含まれない**
ことを確認した。よって手動でのマウント自体は今後も必要であり、`docs/decisions/0052`
ではマウントの粒度だけを修正する方針とした。

## 未解決・持ち越し事項

- th06nc用の旧AMI(`ami-062b165b8b855e6fe`)でこの問題が顕在化していなかった正確な
  経緯(おそらくホスト側に`xserver-xorg-core`相当が入っていた)は未確認。確認には
  本番eu-south-2上の当該AMIへの接続が必要なため、今回は見送った。実害は無い
  (`docs/decisions/0052`の修正によりホスト側のパッケージ構成に依存しなくなるため)。
- 修正後の実際のGPU E2E録画(th15のフル尺Hard・Extra)は、この修正を`apps/api`へ
  反映・本番へデプロイした上で別途実施する。

## 環境・コスト

- us-west-2、g6f.xlarge(Spot)を約40分使用。検証後即座にterminate済み。
- eu-south-2の本番リソース(Launch Template・稼働中のAMI参照)には一切触れていない。
