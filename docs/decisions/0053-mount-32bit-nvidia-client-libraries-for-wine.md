# 0053. GPU用コンテナへ32bit版NVIDIAクライアントライブラリを個別マウントする

- **状態**: 有効
- **決定日**: 2026-09-18
- **対象**: apps/api
- **関連**: Issue #82、PR #264、[`0052`](0052-gpu-xorg-driver-file-level-mount-not-directory.md)、
  `docs/reports/2026-09-18-th15-gpu-32bit-llvmpipe-fallback-root-cause.md`

`apps/api/src/ec2.ts`の`buildUserData()`がGPU系ジョブの`docker run`に付与するマウントへ、
ホストの32bit版NVIDIAクライアントライブラリ（`libGLX_nvidia.so*`・`libnvidia-*.so*`等、
`/usr/lib/i386-linux-gnu/`）を個別ファイルとして追加する。

## 背景

[`0052`](0052-gpu-xorg-driver-file-level-mount-not-directory.md)でXorg起動不能
（`Need libwfb`）を修正し本番E2E検証を再開したところ、th15(32bitタイトル)の録画で
CPU使用率が録画中ずっと約75〜79%に高止まりし、理論尺（`frameCount`/60fps）に対して
実測プレイ時間が**約+83%**超過するという、GPU無し状態よりも悪い結果になった。

`worker/recording/pipeline.py`に一時的な診断コード（`nvidia-smi`によるGPU使用率の
定期ログ、`WINEDEBUG=+opengl,+d3d,+wgl`によるwine.logの詳細出力）を追加して実機調査した
結果:

- `nvidia-smi`のGPU使用率はほぼ終始0%（GPU使用メモリも67MiBのまま変化なし）で、
  実際にはGPUが一切使われていなかった。
- wine.logに以下のエラーが記録されていた:
  ```
  ERROR: libGLX_nvidia.so.0: 共有オブジェクトファイルを開けません:
         そのようなファイルやディレクトリはありません
  ERROR | DRIVER: loader_icd_scan: Failed loading library associated with
         ICD JSON libGLX_nvidia.so.0. Ignoring this JSON
  ...
  trace:wgl:X11DRV_WineGL_InitOpenglInfo GL renderer: llvmpipe (LLVM 20.1.2, 256 bits)
  ```

**th15は32bitアプリケーションであり、32bitのwineプロセスは32bit版の
`libGLX_nvidia.so.0`を必要とするが、コンテナ内のどこにも存在しなかった**ため、
エラーにはならずMesaのソフトウェアレンダラ(llvmpipe)へ静かにフォールバックしていた。
`[`0052`]`で追加したマウントはXorgサーバー自身（64bit）がGPUを使うためのファイル
（`nvidia_drv.so`・`libglxserver_nvidia.so`）のみで、32bitクライアントプロセス向けの
ファイルは一切含んでいなかった。

`nvidia-container-toolkit`（`--gpus all`、`NVIDIA_DRIVER_CAPABILITIES=all`）は
64bit版のNVIDIAユーザースペースライブラリ（`/usr/lib/x86_64-linux-gnu/libnvidia-*.so`等）
は自動でコンテナへマウントするが、**32bit互換ライブラリの自動マウントには対応していない**
（nvidia-container-toolkitの既知の制約）。th06nc（64bit専用）がこれまで問題にならな
かったのはこのため——64bitタイトルは自動マウントの範囲内で完結する。

**touhou-recorder側でこの問題に一度も遭遇しなかった理由**: touhou-recorderのGPU検証
（reports/81・82）はDockerコンテナを使わず、wineをホストVM上で直接ネイティブ実行して
いた（reports/81「ゲーム一式はDockerイメージではなくrsyncで直接持ち込んだ」）。
コンテナ境界が無いため、32bitプロセスはホストの`--compat32-libdir`で導入済みの
32bit版NVIDIAライブラリをそのままdlopenでき、この問題自体が発生し得なかった。
**sattoriのDocker化されたワーカーアーキテクチャに固有の問題**である。

## 決定

- `docker run`のマウントへ、ホストの`/usr/lib/i386-linux-gnu/`配下のNVIDIA関連
  ファイル（`libnvidia-*.so*`・`libGLX_nvidia.so*`・`libEGL_nvidia.so*`・
  `libGLESv1_CM_nvidia.so*`・`libGLESv2_nvidia.so*`）を個別に`:ro`で追加マウントする
  （[`0052`](0052-gpu-xorg-driver-file-level-mount-not-directory.md)と同じ理由で
  ディレクトリ丸ごとはマウントしない——コンテナ自身の32bit版Mesa
  （`worker/Dockerfile.gpu`が導入する`libgl1-mesa-dri:i386`等）を隠してしまうため）。
- ホストAMI側に32bit互換ドライバ（`--compat32-libdir`、`build-gpu-worker-ami` skill）が
  導入されていない場合（64bit専用タイトルのみ運用していた旧AMI等）は該当ファイルが
  存在せずマウントは単に空になる。実害はなく、既存の64bit専用タイトル（th06nc）にも
  影響しない。

## 根拠

- 実機検証（`docs/reports/2026-09-18-th15-gpu-32bit-llvmpipe-fallback-root-cause.md`）で、
  修正前は`libGLX_nvidia.so.0`のロード失敗とllvmpipeへのフォールバックを確認し、
  対象ファイルを個別マウントする方式で解消することを確認した。

## 採らなかった選択肢

- **`/usr/lib/i386-linux-gnu`をディレクトリごとマウントする**: `0052`と同じ理由
  （コンテナ自身の32bit版Mesa等を隠してしまう）で採らなかった。
- **nvidia-container-toolkitの設定変更で32bit自動マウントを有効化する**:
  nvidia-container-toolkit自体が32bit compat向けの正式な自動マウント機構を持たない
  （2026-09時点）ため、この経路は無い。

## 影響範囲

- `apps/api/src/ec2.ts`の`buildUserData()`（`apps/api/src/ec2.test.ts`のGPU系テストも
  合わせて更新済み）。32bitのGPU系タイトル（現状th15のみ）に影響する。
- `worker/recording/pipeline.py`: GPU使用率(`nvidia-smi`)を録画中ログへ定期出力する
  軽量な恒久診断を追加した（原因調査時に使った一時診断とは別に、今後同種の
  「GPU描画が有効なはずなのに効いていない」不具合を早期発見するため）。
