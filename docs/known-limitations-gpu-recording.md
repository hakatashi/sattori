# 既知の制約: GPU録画・倍速録画

GPU インスタンスで録画するもの（倍速録画、th06nc、th15）に固有の品質上の制約・未検証事項・
未実装事項の詳細。これらの録画経路や GPU 容量不足時のフォールバックを触る前に読むこと。
[`known-limitations.md`](known-limitations.md) §1 から分けた（索引はあちらに残してある）。

## 目次

- [1. 倍速録画（2〜4倍速）の品質と未実装事項（Issue #288）](#1-倍速録画24倍速の品質と未実装事項issue-288)
- [2. th06nc は GPU 描画が基本で、GPU が無ければ CPU の 1/2 倍速](#2-th06nc-は-gpu-描画が基本でgpu-が無ければ-cpu-の-12-倍速)
- [3. th15 は GPU を優先し、確保できなければ CPU 低速で録画する](#3-th15-は-gpu-を優先し確保できなければ-cpu-低速で録画する)

## 1. 倍速録画（2〜4倍速）の品質と未実装事項（Issue #288）

[`decisions/0058`](decisions/0058-speedup-recording-on-gpu-instances.md)。技術検証は
touhou-recorder reports/84〜90（us-west-2のg6f.2xlarge、ホスト直接実行）。本番構成
（eu-south-2・カスタムAMI上のDocker）では全12タイトルを2倍速（th07は3倍速、th06は4倍速も）で
検証済み（[`reports/2026-10-02`](reports/2026-10-02-speedup-production-e2e.md)）。

- **3倍速以上はx11grabのキャプチャが律速**し、等倍へ戻した後の落ちフレームが3倍速で1〜3%、
  4倍速で7〜9%に増える（ゲーム自体は目標fpsを維持している、reports/89 §4）。th15は3倍速でも
  ゲーム本体が律速して14%（reports/87）。4倍速は実質的に非推奨で、UIは警告付きで選ばせる。
- **th20の2倍速は落ちフレーム1.6%**（等倍0.1%）。ゲーム本体の単一スレッド性能が足りない。
- **ステージ間のロード等「実時間で進む区間」は等倍へ戻すとN倍に伸びる**（th06の全6面で約+2秒）。
  ゲーム内容の欠落ではない。一部タイトル（th07/08/09）はBGMと画面が+0.15〜0.2秒ずれ、
  th06nc/th11/th128では時間とともに変わる（ゲーム側のBGMストリーミングに起因、パイプラインの
  誤差は±20ms、reports/89 §6）。
- **同期マーカー（約3秒の-42dBFSノイズ）は配信版には残らない**。音声の録音をゲームの起動直後に
  始め、ゲームの初期化が済みしだい鳴らして、配信版でカットする区間へ追い出している。メニュー操作の
  速いタイトル（th07の等倍・3倍速）では、重ならないようカット開始を遅らせるので、リプレイ選択画面を
  見せる時間が1秒より少し短くなる（Issue #266、[`decisions/0059`](decisions/0059-cut-range-decided-by-recorder.md)）。
  カット開始を決められなかった録画（MODログに再生確定の記録が無い等）では、映像の先頭から残るので
  マーカーが入りうる。
- **GPU容量を確保できない場合は次の段で録る**（Issue #289・#315・#316・#317、
  [`decisions/0063`](decisions/0063-spot-capacity-shortage-is-permanent-within-a-job.md)・[`0064`](decisions/0064-cpu-slow-motion-and-g6-fallback-on-gpu-shortage.md)・[`0066`](decisions/0066-recording-fallback-plan-as-config.md)・[`0067`](decisions/0067-th06nc-cpu-slow-motion-and-drop-1080p.md)）。
  通常のタイトルは等倍へ、th15・th20・th06ncはCPU低速録画へ進む。段の閾値（待ち30分・クォータ超過などの
  3回目）は本番の実測に基づかない初期値。
- **CPU低速録画の品質はGPU録画より落ちる**（[`decisions/0064`](decisions/0064-cpu-slow-motion-and-g6-fallback-on-gpu-shortage.md)）。ボムやスペルカード終了時に
  一時的なコマ落ちがあり、高負荷のあとはBGMが映像より先行する（th20で約0.5秒、touhou-recorder
  reports/91 §6）。実時間は尺の約2倍（th15 Extraは約3倍）。本番E2Eは各条件1本で、Spotの実際の中断は未確認
  （[`reports/2026-11-05`](reports/2026-11-05-cpu-slow-motion-production-e2e.md)）。
  `c7i.4xlarge`の1タイプしか候補が無く、Spot中断は録画からやり直し（reports/91 §7）。尺60分級のリプレイは
  ルートボリューム（30GiB）に近づく（[`reports/2026-11-05`](reports/2026-11-05-cpu-slow-motion-worker-local.md)）。
- **th06ncのCPU低速録画（BC7展開、`c7i.2xlarge`）は、Extraの高密度弾幕で描画が落ちる**
  （[`decisions/0067`](decisions/0067-th06nc-cpu-slow-motion-and-drop-1080p.md)）。touhou-recorder reports/97では、
  パチュリー戦（配信版75〜165秒）で描画が実時間約15Hzへ間引かれ、その区間の落ちが25〜36%（Extra全体で7.6%）。
  ゲームの進行は正しく、コマ落ちとして見える。**th06ncのFpsMonitorは入力ポーリング回数を数えているので、この
  描画落ちを示さず、パイプラインの判定重複率でも検知できない**（reports/97 §3）。品質は配信版のユニークフレームで
  見ること。CPU等倍・`c7i.xlarge`は不採用。
- **リプレイが始まらなかった録画が`done`になりうる**。メニュー操作を取りこぼしても、背景の動く画面なら重複率で弾けず、
  画面静止で終了と判定される（th15 20Hzで実例）。スコアは`desyncDetected`に出るだけで、リトライしない。

## 2. th06nc は GPU 描画が基本で、GPU が無ければ CPU の 1/2 倍速

2026-09-10 発売の「東方紅魔郷: New Classic」は録画対応済み（Issue #241、
[`worker/docs/titles/th06nc.md`](../worker/docs/titles/th06nc.md)）。**通常はGPU描画
（Xorg+NVIDIA GRIDドライバ+DXVK）でGPU系インスタンス（`g6f.2xlarge`）の2倍速で録画し、GPUを確保できなければ
CPU描画（`c7i.2xlarge`、1/2倍速）で録る**。CPU描画はMODがBC7テクスチャをロード時に展開して初めて60fpsに
届く（展開しないと720pで9.1fps、touhou-recorder reports/78・96）。自宅ワーカーには常にオファーされない
（[`decisions/0047`](decisions/0047-no-gpu-titles-for-home-worker.md)・[`0067`](decisions/0067-th06nc-cpu-slow-motion-and-drop-1080p.md)）。
**1080p録画は廃止した**（0067）。

GPUの起動候補は`g6f.2xlarge`（8vCPU）だけ（Issue #288、
[`decisions/0058`](decisions/0058-speedup-recording-on-gpu-instances.md)）。以前は`g6f.xlarge`（4vCPU）も
候補で、1080p録画が4vCPUで起動すると実効fpsが54.87まで悪化しうる（touhou-recorder reports/81 §9.9.3）
制約があったが解消した。
クオータ（`GPU_VCPU_QUOTA`）の範囲内でジョブを順番待ちさせる仕組みは
[`decisions/0056`](decisions/0056-gpu-vcpu-lease-and-queue.md)。

同時発売の「東方紅魔郷: Classic」（th06c）も録画対応済み（Issue #240、
[`worker/docs/titles/th06c.md`](../worker/docs/titles/th06c.md)、こちらはGPU不要）。

**th06nc を th06 として受け付けてはならない。** マジックバイトは th06 と同じ `T6RP` の
ままなので、バージョン語（0x04）を見ない実装は誤って th06 として扱ってしまう
（th06c も同様の非互換だったが、既に別`GameId`として扱われているため対応済み。
Classic系のリプレイ（ver. 1.03系）は th06 1.02h ではファイルとして認識されず、
録画が必ず失敗する。逆方向、すなわち 1.02h のリプレイを 1.03 で再生することは可能）。

解析上の未確定事項（クリア判定フラグ、New Classic のスペルプラクティスの難易度、
モード値 2 の意味）は`docs/research/th06-classic-replay-format.md` §6に、追加で
必要なリプレイの種類とあわせて挙げてある。メニューカーソル位置・ステージ番号・
残機・グレイズのRVAも未特定（`worker/docs/titles/th06nc.md`参照）。

**【2026-09-12時点】本番相当のE2E録画検証（720p/1080pのフル尺録画）はまだ完了して
いない**。GPU用カスタムAMI構築・CDKデプロイ・タイトル資産アップロードは完了済みだが、
eu-south-2のg6f.xlargeスポット在庫の長時間枯渇により実際の録画ジョブが起動できな
かった（sattori側の不具合ではない、
[`docs/reports/2026-09-12-th06nc-recording-verification.md`](reports/2026-09-12-th06nc-recording-verification.md)）。
在庫回復後に必ず再検証すること。

GPU用カスタムAMIとworker-gpuイメージのドライババージョン同期、初回起動時の
wineserverコールドスタートによる録画失敗しやすさは`worker/docs/titles/th06nc.md`
「既知の残課題」を参照。`worker/recording/pipeline.py`の`_record_with_retry()`が
重複フレーム率計測不能（`None`）を異常として扱っていない問題も、th06nc対応と合わせて
修正していない（実機観測後に必要性を判断する）。

## 3. th15 は GPU を優先し、確保できなければ CPU 低速で録画する

th15は録画対応済み（Issue #82、[`worker/docs/titles/th15.md`](../worker/docs/titles/th15.md)）。
th06ncとは異なり**GPU描画が原理的に必須なわけではない**——wined3d(D3D9→OpenGL)描画で
あり、Xvfb+llvmpipe(ソフトウェア描画)でもメニュー・通常ステージはネイティブfps付近で
動作する。ただしExtraステージの高負荷演出区間ではCPUコア数を増やしても解消しない
処理落ちが発生し、GPU（wined3d+OpenGLのまま、DXVKではない）に切り替えることで解消
することを実機確認したため（touhou-recorder reports/82）、品質を優先してth06ncと
同じ`g6f`系GPUインスタンスを優先する。確保できなければ`c7i.4xlarge`の低速録画へ落ちる
（[`decisions/0064`](decisions/0064-cpu-slow-motion-and-g6-fallback-on-gpu-shortage.md)）。自宅ワーカー（GPU非搭載）には
常にオファーされない（[`decisions/0047`](decisions/0047-no-gpu-titles-for-home-worker.md)）。

**入力ポーリング方式はth11/th20のGetKeyboardStateではなく、th06/07/08/10と同じ
GetDeviceStateである**。「TH10以降のエンジンはGetKeyboardState」という経験則は
th15には当てはまらない（`worker/docs/titles/th15.md`）。

このマシン（HakataMatrix、自宅ワーカー本体）にはNVIDIA GPUが無いため、th06ncと
同じ理由でローカルでのGPU描画経路の検証はできない（`verify-recording-locally`
skill §0.0）。ローカルでは`gpu_display=False`（Xvfb+wined3d）へ一時的に切り替えて
MOD・録画パイプライン結合（メニュー自動操作・スコア監視・終了検知）のみ検証済み。

sattori側のコード・AWSインフラを通したGPU E2E録画は本番環境（eu-south-2、
g6f.2xlarge）で実機検証済み（Extraステージ`th15_08.rpy`、重複フレーム率0.2%、
理論尺超過+0.8%、`docs/reports/2026-09-18-th15-gpu-32bit-llvmpipe-fallback-root-cause.md`）。
検証の過程で、32bitタイトル(th15)特有の問題——nvidia-container-toolkitが32bit互換
NVIDIAクライアントライブラリを自動マウントしないため、修正前はGPU描画が有効なはずの
状態でMesaのソフトウェアレンダラ(llvmpipe)へ静かにフォールバックしていた——を発見・
修正した（[`decisions/0053`](decisions/0053-mount-32bit-nvidia-client-libraries-for-wine.md)）。
GPUによるExtraステージの処理落ち解消自体はtouhou-recorder側でも実機検証済み
（reports/82、AWS g6f.2xlarge）。

ステージ番号のRVAは未特定（`thprac_th15.cpp`にも単純な変数が見当たらない）。
