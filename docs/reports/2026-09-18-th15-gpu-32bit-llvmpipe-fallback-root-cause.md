# th15 GPU描画が実際には効かずllvmpipeへフォールバックしていた問題の根本原因調査

- **検証日**: 2026-09-18
- **対象**: `docs/decisions/0052`でXorg起動不能を修正した後の本番E2E再検証(eu-south-2、Issue #82、PR #264)
- **結論**: **th15(32bitタイトル)のGPU描画は実際には効いておらず、wineがMesaの
  ソフトウェアレンダラ(llvmpipe)へ静かにフォールバックしていた**。原因は
  nvidia-container-toolkitが32bit互換のNVIDIAクライアントライブラリを自動マウント
  しないため。ホストの該当ファイルを個別マウントする修正
  （[`docs/decisions/0053`](../decisions/0053-mount-32bit-nvidia-client-libraries-for-wine.md)）
  で解消した。

## 経緯

### 表面化した異常

`docs/decisions/0052`の修正（Xorg起動不能の解消）後、th15 Extraステージ
(`th15_08.rpy`)の本番E2E録画を再試行したところ、パイプライン内蔵の重複フレーム率
チェック（録画開始15〜45秒のスポット、閾値30%）が**42.1%**で発火し、自動的に
リトライされた。

当初、この時間帯にth15 Extra特有の「Chapter Finish」という静止したスコア集計画面
（東方紺珠伝のチャプター制ゲームプレイに由来）が重なった誤検知ではないかと推測したが、
ユーザーからの指摘（画面内の「60」表示はリプレイ記録時fpsであり実際の再生fpsではない）
を受けて理論尺比較（`frameCount`/60fps）で検証し直したところ、以下が判明した:

- 総録画時間: 1427.9秒（パイプラインのログで直接報告）
- メニュー操作: 約12.9秒、静止検知待機: 約16.3秒
- 実測プレイ時間 ≈ 1398.7秒
- 理論尺（`frameCount` 45872 @ 60fps）: 765秒
- **超過率: 約+82.8%**（GPU無し状態での前回試行の+39%よりも悪化、touhou-recorder
  実機検証でのGPU有効時+0.89%とは大きく乖離）

CloudWatchのEC2 `CPUUtilization`メトリクスも録画中ずっと約75〜79%で高止まりしており、
GPU無しでの以前の失敗試行と同じシグネチャだった。

### 診断: nvidia-smiによるGPU使用率の実測

`worker/recording/pipeline.py`のポーリングループへ一時的に`nvidia-smi
--query-gpu=utilization.gpu,utilization.memory,memory.used`を約10秒間隔でログ出力する
診断コードを追加し、th15の短尺リプレイ(`th15_01.rpy`)で再実行した。結果、
**GPU使用率はほぼ終始0%（まれに1〜22%の単発ノイズ）、GPU使用メモリは67MiBのまま
録画中一切変化しなかった**。これは実際のゲーム描画がGPUで行われている状態とは
明らかに異なる。

### 診断: WINEDEBUGによるwine.log解析

さらに`WINEDEBUG=+opengl,+d3d,+wgl`を設定し、wine.logの内容から
`GL_RENDERER`/`llvmpipe`/`NVIDIA`等のキーワードを含む行を抽出したところ、以下が
見つかった:

```
ERROR:             libGLX_nvidia.so.0: 共有オブジェクトファイルを開けません:
                    そのようなファイルやディレクトリはありません
ERROR | DRIVER:    loader_icd_scan: Failed loading library associated with
                    ICD JSON libGLX_nvidia.so.0. Ignoring this JSON
...
00d8:trace:wgl:X11DRV_WineGL_InitOpenglInfo GL renderer            : llvmpipe (LLVM 20.1.2, 256 bits).
```

**th15は32bitアプリケーションであり、32bitのwineプロセスは32bit版の
`libGLX_nvidia.so.0`を必要とするが、コンテナ内に存在しなかった**ため、Vulkan/OpenGL
ローダーがこのICDを黙って無視し、Mesaのソフトウェアレンダラ(llvmpipe)へ
フォールバックしていた。

### 原因: nvidia-container-toolkitは32bit互換ライブラリを自動マウントしない

`docs/decisions/0052`で追加したマウント（`nvidia_drv.so`・`libglxserver_nvidia.so`）は
**Xorgサーバー自身(64bit)がGPUを使うためのファイルのみ**で、これは正しく機能していた
（Xorg起動時の`glxinfo`診断ログで`NVIDIA L4-6Q`を確認済み）。しかし32bitクライアント
プロセス(wine)向けのファイルは一切マウントしていなかった。

`nvidia-container-toolkit`(`--gpus all`、`NVIDIA_DRIVER_CAPABILITIES=all`)は
64bit版のNVIDIAユーザースペースライブラリ(`/usr/lib/x86_64-linux-gnu/libnvidia-*.so`等)
は自動でコンテナへマウントすることを確認済み(マウント無しの状態でも`ldconfig -p`で
多数の`libnvidia-*.so`が確認できた)が、**32bit互換ライブラリの自動マウントには
対応していない**(既知の制約)。th06nc(64bit専用)がこれまで問題にならなかったのは、
このタイトルが32bitプロセスを一切持たないため。

### なぜtouhou-recorderの実機検証(reports/82)ではこの問題が起きなかったか

touhou-recorderのGPU検証は**Dockerコンテナを使わず、wineをホストVM上で直接
ネイティブ実行**していた(reports/81「ゲーム一式(約2.2GB)はDockerイメージではなく
rsyncで直接持ち込んだ」)。コンテナ境界が無いため、32bitプロセスはホストの
`--compat32-libdir`で導入済みの32bit版NVIDIAライブラリをそのままdlopenでき、この
問題自体が発生し得なかった。**sattoriのDocker化されたワーカーアーキテクチャに
固有の問題**であり、decision 0050が引用する「touhou-recorderでの実機検証済み」は
GPU自体の効果(処理落ち解消)については正しいが、コンテナ経由でのGPU利用可否までは
検証範囲に含まれていなかった。

## 対応

`apps/api/src/ec2.ts`の`docker run`マウントへ、ホストの
`/usr/lib/i386-linux-gnu/libnvidia-*.so*`・`libGLX_nvidia.so*`・`libEGL_nvidia.so*`・
`libGLESv1_CM_nvidia.so*`・`libGLESv2_nvidia.so*`を個別ファイルとして追加マウントする
修正を行った(`docs/decisions/0053`)。`0052`と同じ理由でディレクトリ丸ごとの
マウントは避けている。

`worker/recording/pipeline.py`には、今後同種の問題(GPU描画が有効なはずなのに実際は
効いていない)を早期発見できるよう、`nvidia-smi`によるGPU使用率の定期ログを恒久的な
軽量診断として残した(調査に使った`WINEDEBUG`・wine.log全文ダンプは、ログ量が
録画数十秒で数百MB〜GB単位に達し録画自体の負荷になるため削除済み)。

## 未実施(次回への引き継ぎ)

- 上記修正を反映した状態でのth15フル尺(Hard・Extra)E2E録画・理論尺比較・fps目視確認。
- th06nc(64bit専用)の回帰確認(このマウント変更が既存タイトルに影響しないことの実機確認)。

## 環境

- eu-south-2、g6f.2xlarge(本番)。診断のため`worker-gpu`イメージを3回再ビルド・pushし、
  短尺リプレイ(`th15_01.rpy`)で計3回の短時間ジョブを実行・手動停止した。
