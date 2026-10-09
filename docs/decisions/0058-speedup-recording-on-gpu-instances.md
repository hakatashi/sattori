# 0058. 倍速録画（2〜4倍速）を導入し、2倍速以上はGPUインスタンス（g6f.2xlargeのみ）で録画する

- **状態**: 有効
- **決定日**: 2026-09-30
- **対象**: packages/shared / apps/api / infra / worker
- **関連**: Issue #288、#289、`docs/decisions/0010-slow-motion-no-worker-side-branching.md`、
  `docs/decisions/0045-ec2-slow-motion-for-th20.md`、
  `docs/decisions/0046-gpu-ec2-instance-and-fixed-ami.md`、
  `docs/decisions/0047-no-gpu-titles-for-home-worker.md`、
  `docs/decisions/0056-gpu-vcpu-lease-and-queue.md`、touhou-recorder reports/84〜90

ゲームを内部的にN倍速（2〜4倍速）で動かして録画し、後処理で等倍へ戻す「倍速録画」を
導入する。**GPUが要るかはタイトルではなくジョブ（タイトル＋録画速度）で決まる**ようになった
（`requiresGpuRecording(job)`）。タイトルだけを見てGPU経路・自宅ワーカーへのオファー・
コスト帯を決めるコードを書くと、倍速録画のジョブがCPUインスタンスや自宅ワーカーへ落ちる。

## 背景

- eu-south-2のG系スポットクオータが32vCPU（g6f.2xlarge×4）に拡張された（`0056`）。
- touhou-recorder reports/84〜90で、GPU描画（Xorg+nvidia）＋NVENC録画のg6f.2xlargeなら
  全タイトルで2倍速録画が実用品質になることを確認した（録画時間は等倍の52〜54%、
  等倍へ戻した後の落ちフレームは等倍と同等。th20のみ1.6%と劣る）。3倍速以上はx11grabの
  キャプチャが律速し落ちフレームが増える（3倍速1〜3%、4倍速7〜9%）。
- CPU描画（Xvfb+llvmpipe）では2倍速を維持できない（reports/90でth20はFpsMonitor 47Hz）。
  g6f.xlarge（4vCPU）ではゲーム本体とキャプチャ・エンコードがCPUを奪い合う（reports/85）。

## 決定

- **録画速度は `RecordingOptions.recordingSpeed`（1〜4、欠損は1）**。定数とおすすめ速度は
  `packages/shared/src/recordingSpeed.ts`。`POST /magic-links`は全タイトルで受け付け、
  公開範囲はフロントエンドの定数で段階的に広げる（本番で直接APIを叩いてE2E検証するため）。
- **2倍速以上、およびth06nc・th15（`GPU_RECORDING_GAME_IDS`）はGPU必須**
  （`packages/shared/src/gpuRecording.ts`の`requiresGpuRecording(job)`）。GPU必須のジョブは
  自宅ワーカーへオファーしない（`apps/api/src/workerRouting.ts`の`GPU_ONLY_ROUTING_POLICY`）、
  GPU vCPU枠をリースする（`handlers/sfn/acquireGpuSlot.ts`）、GPU系Launch Template・
  `worker-gpu`イメージで起動する（`apps/api/src/ec2.ts`）。
- **GPUの起動候補は`g6f.2xlarge`だけ**（`GPU_CANDIDATE_INSTANCE_TYPES`）。リースの確保量も
  8vCPU固定（`GPU_INSTANCE_VCPU`）。vCPU会計の表（`GPU_INSTANCE_TYPE_VCPUS`）には
  稼働中インスタンスとの突き合わせのため`g6f.xlarge`を残す。
- **ワーカーへは`FPS_LIMIT_TARGET_HZ=60×N`だけを渡す**（`apps/api/src/workerEnv.ts`）。
  QPC偽装の倍率`SPEED_HACK_MULTIPLIER`はワーカーがここから導出する
  （`worker/recording/config.py`）。GPU必須のジョブには`GPU_WORKER=1`を渡し、ワーカーは
  GPU描画必須でないタイトルもGPU描画・NVENCで録画・変換する（`0010`の「ワーカーに
  自宅/EC2の分岐を作らず、起動側の環境変数で表す」を踏襲）。
- **A/V同期は全速度で同期マーカー方式にする**（`worker/recording/sync_marker.py`、reports/88）。
  録音開始2秒後にゲーム自身の音声デバイスから約3秒・-42dBFSの疑似乱数ノイズを鳴らし、
  音声上の位置から補正する。start_time差の従来方式は等倍でも+90〜+190ms遅れており、
  倍速録画では等倍へ戻す際にN倍へ拡大されるため。
- 低速録画（`slowMotion`）とは排他で、両方指定されたら倍速を優先する。低速録画自体は
  UIの全タイトル公開と同時に廃止する（Issue #288の最終段）。

## 根拠

- 品質・所要時間: touhou-recorder reports/89（全タイトル2倍速、th06〜08の3・4倍速）、
  reports/90（th06cの1〜4倍速、画面上のfps表示）、reports/85・87（th15）。
- 音質: reports/86（録音シンクのレートとAACの`-cutoff`、3倍速以上はALAC）。
- 音ズレ: reports/88（合成プローブで±20ms以内）。
- コスト: 2026-08-30〜09-29の本番188件におすすめ速度を当てはめた見積もりで、EC2費用は
  月$4.6→$4.0〜4.9（g6f.2xlargeの単価$0.08〜0.10/時）とほぼ横ばい（th20・th06nc・th15は減、
  自宅ワーカーで無料だった分とCPU系の一部は増）。

## 採らなかった選択肢

- **タイトル単位でGPU必須を決め続ける（倍速録画対応タイトルを`GPU_RECORDING_GAME_IDS`へ足す）**。
  等倍を選んだジョブまでGPUへ回り、自宅ワーカーで無料で録れていた分のコストが増える。
  ユーザーが等倍を選んだときの挙動を変えないという要件にも反する。
- **`SPEED_HACK_MULTIPLIER`も起動側から渡す**。2つの値が食い違うと、ゲーム進行（QPC）と
  Present上限・音声レートがずれ、しかもワーカーからは検知できない。出所を1つにする。
- **g6f.xlargeを候補に残す**。eu-south-2で長期間枯渇しており、倍速録画は4vCPUで未検証
  （reports/85で処理落ち）。
- **GPUを確保できないときにCPUの等倍録画へ自動で落とす**。経路が複雑になるため今回は見送り、
  Issue #289で扱う（→ [`0060`](0060-speedup-fallback-to-native-speed.md)で実装）。

## 影響範囲

- GPU要否を判定する箇所は必ず`requiresGpuRecording(job)`を通すこと（`ec2.ts`・
  `workerRouting.ts`・`handlers/sfn/launch.ts`・`handlers/sfn/acquireGpuSlot.ts`・
  `packages/shared/src/cost.ts`）。`GPU_RECORDING_GAME_IDS`を直接見てよいのは
  「録画速度によらずGPUで録るタイトル」を知りたい箇所（`home-worker/src/config.ts`の
  既定対象タイトル等）だけ。
- GPU待ち行列のETA（`packages/shared/src/gpuQueue.ts`の`estimateGpuOccupancySeconds()`）と
  UIの推定時間（`recordingSpeed.ts`の`estimateRecordingCompletionSeconds()`）は録画速度を
  織り込む。係数は本番検証で見直す。
- 倍速録画時のワーカー側の挙動（キャプチャfps・音声・監視・変換）は`worker/README.md` §5。
