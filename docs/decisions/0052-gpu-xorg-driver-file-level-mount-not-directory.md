# 0052. GPU用コンテナへのXorg NVIDIAドライバ受け渡しはディレクトリ丸ごとではなくファイル単位でマウントする

- **状態**: 有効
- **決定日**: 2026-09-18
- **対象**: apps/api
- **関連**: Issue #82、PR #264、`docs/reports/2026-09-17-th15-production-e2e-attempt.md`、
  `docs/reports/2026-09-18-th15-gpu-ami-xorg-libwfb-root-cause.md`

`apps/api/src/ec2.ts`の`buildUserData()`がGPU系ジョブの`docker run`に付与するマウントを、
`-v /usr/lib/xorg/modules:/usr/lib/xorg/modules:ro`（ホストのディレクトリを丸ごと
コンテナへかぶせる）から、NVIDIAドライバが実際に配置した個々のファイル
（`nvidia_drv.so`・`libglxserver_nvidia.so*`）だけを実行時にシェルで列挙して個別マウント
する方式に変更する。

## 背景

th15のGPU用カスタムAMIに32bit互換NVIDIAドライバを追加して本番E2E検証を試みたところ、
Xorgが`(EE) NVIDIA(0): Need libwfb but wfbScreenInit not found`で起動不能になった
（`docs/reports/2026-09-17-th15-production-e2e-attempt.md`）。当初はAMI構築手順
（`--compat32-libdir`指定）に問題があると推測したが、us-west-2の一時インスタンス上で
実際のコンテナ実行を再現した結果、**原因はAMIではなく`docker run`のマウント方法**
だったと判明した（`docs/reports/2026-09-18-th15-gpu-ami-xorg-libwfb-root-cause.md`）。

`docker run -v <host>:<container>`のbind mountは、コンテナ側のマウント先に**既存の
内容があってもすべて隠す**（マージしない）。GPU用ワーカーコンテナ（`worker/Dockerfile.gpu`）
自身も`xserver-xorg-core`を導入しており`/usr/lib/xorg/modules/`配下に`libwfb.so`等の
標準モジュールを持っているが、ディレクトリ丸ごとマウントするとこれがすべて隠れ、
ホスト側の内容（NVIDIAドライバのインストーラが置いた`nvidia_drv.so`・
`libglxserver_nvidia.so*`のみ）に置き換わってしまう。ホストAMI側に`xserver-xorg-core`
相当のパッケージが入っていなければ、コンテナは`libwfb.so`を失った状態でXorgを起動する
ことになり、上記のエラーで即座に失敗する。

th06nc用の旧AMI（`ami-062b165b8b855e6fe`）でこの問題が顕在化していなかった正確な経緯は
未確認（ホスト側に`xserver-xorg-core`相当が入っていた可能性が高いが、確認には本番
eu-south-2への接続が必要なため見送った）。**いずれにせよこの不具合はth15固有でもAMI
固有でもなく、GPU系ジョブ全体に共通するdocker実行時の設定ミスであり、ホストAMIの
パッケージ構成にXorgの起動可否が偶然依存してしまっている状態自体が脆弱だった。**

## 決定

- `docker run`のマウントを、ホストの`/usr/lib/xorg/modules/drivers/nvidia_drv.so`と
  `/usr/lib/xorg/modules/extensions/libglxserver_nvidia.so*`（バージョン番号を含む
  ファイル名のため決め打ちせずグロブで列挙する）だけを個別に`:ro`でマウントする方式に
  変更した（`buildUserData()`内、UserDataスクリプトが起動時に`GPU_XORG_MOUNTS`変数を
  組み立てる）。
- これによりコンテナ自身の`xserver-xorg-core`由来モジュール（`libwfb.so`等）は一切
  隠れず、**ホストAMI側のパッケージ構成（`xserver-xorg-core`の有無やバージョン）に
  一切依存しなくなる**。

## 根拠

- us-west-2の一時インスタンス+実際のDockerコンテナ（`ubuntu:24.04`+
  `xserver-xorg-core`導入+NVIDIA GRIDドライバ595.91.07）で、ディレクトリ丸ごとマウント
  時に同一のエラー（`Need libwfb but wfbScreenInit not found`）を再現し、個別ファイル
  マウントに変更した場合にXorgが正常起動する（`xdpyinfo`成功）ことを確認した
  （`docs/reports/2026-09-18-th15-gpu-ami-xorg-libwfb-root-cause.md`）。
- `nvidia-container-toolkit`（`--gpus all`、`NVIDIA_DRIVER_CAPABILITIES=all`）は
  `libnvidia-*.so`系のユーザースペースライブラリは自動マウントするが、Xorg用の
  `nvidia_drv.so`・`libglxserver_nvidia.so`は自動マウントしない（同レポートで確認）
  ため、この手動マウント自体は今後も必要。

## 採らなかった選択肢

- **ホストAMI（`build-gpu-worker-ami` skill）側に`xserver-xorg-core`等を追加で
  インストールする**: ディレクトリ丸ごとマウントのままでも動くようにはなるが、
  ホストAMIとコンテナイメージという独立に再構築されうる2つの成果物の間で
  `xserver-xorg-core`のバージョンを一致させ続ける必要が生じ、どちらか一方だけを
  更新すると再び同種の不具合が再発しうる。ファイル単位マウントの方が結合を根本的に
  切り離せるため採らなかった。
- **AMIを`--compat32-libdir`無しの状態にロールバックしたまま維持する**: th15の
  GPU描画（32bit）自体が使えなくなり、Issue #82の目的を達成できないため不可。

## 影響範囲

- `apps/api/src/ec2.ts`の`buildUserData()`（`apps/api/src/ec2.test.ts`のGPU系テストも
  合わせて更新済み）。th06nc・th15双方のGPU系ジョブに影響する。
- `.claude/skills/build-gpu-worker-ami/SKILL.md`: ホストAMI側に`xserver-xorg-core`等の
  Xorgパッケージを追加インストールする必要が無いことが明確になった（元々このskillは
  そのようなインストール手順を含んでいなかった。従来動いていたのはたまたまだった
  可能性がある、という経緯の記録として本ADRを参照させる）。
