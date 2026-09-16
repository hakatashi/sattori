# 0050. th15はGPU描画が原理的に必須ではないが、th06ncと同じGPU系インスタンス(g6f系)に固定する

- **状態**: 有効
- **決定日**: 2026-09-17
- **対象**: worker / apps/api / packages/shared
- **関連**: Issue #82、`docs/decisions/0046-gpu-ec2-instance-and-fixed-ami.md`、
  `docs/decisions/0047-no-gpu-titles-for-home-worker.md`、
  `docs/decisions/0048-separate-ecr-repo-for-gpu-workers.md`、
  touhou-recorder reports/82

th15（東方紺珠伝）の録画に使うEC2インスタンスタイプを、th06ncと同じGPU系
（`g6f.xlarge`/`g6f.2xlarge`）に固定する。ただしth06ncと異なり、**th15はGPUが無いと
録画が原理的に成立しないタイトルではない**——品質を優先した選択である。

## 背景

th15はwined3d（D3D9→OpenGL）で描画するタイトルで、Xvfb+llvmpipe（ソフトウェア描画、
既存9タイトルと同じ経路）でもメニュー・通常ステージ（Hard、全クリア）はネイティブfps
付近で動作し、理論尺比較で+1.2%程度の良好な結果が出ることを実機確認した
（touhou-recorder reports/82）。問題はExtraステージの高負荷演出区間に限定され、ここで
ゲーム内蔵fpsカウンターが実測30fps前後まで低下する処理落ちが発生する（理論尺超過
+6.1%）。

この処理落ちは**CPUコア数を増やしても解消しない**ことを実機確認済み（ローカル4vCPU相当と
AWS c7i.4xlarge(16vCPU)で、同一スペルカード演出の複数地点サンプリングが平均43.6fps/
44.1fps・最低17.9fps/15.2fpsとほぼ同水準）。単一スレッドの処理速度（wined3dの
Direct3D9→OpenGL変換、もしくはゲーム本体のロジック処理）がボトルネックと見られる。

以下2つの対策が有効であることを実機確認した:

1. **GPU（wined3d+OpenGL、g6f.2xlarge）**: 全地点で59.9〜60.0fpsに改善、理論尺超過も
   +0.89%まで改善。
2. **低速録画（`FPS_LIMIT_TARGET_HZ=30`）**: 理論尺超過+1.4%、フレーム抽出で30.0fps
   安定を確認。

## 決定

- th15を`GPU_RECORDING_GAME_IDS`（`packages/shared/src/gpuRecording.ts`）に追加し、
  th06ncと同じ`GPU_CANDIDATE_INSTANCE_TYPES`（`apps/api/src/ec2.ts`）・
  `worker/Dockerfile.gpu`・ECRリポジトリ（`sattori-worker-gpu`）を再利用する。
- `GameConfig.gpu_display=True`とするが、**DXVKは使わない**
  （`dxvk_dll_overrides`は指定しない）。th15はD3D9タイトルで元々wined3dが使える上、
  DXVK v3.1.1がこのGPU（GRIDドライバのVulkan実装）を`Skipping: Device does not
  support required feature 'khrLoadStoreOpNone'`で拒否し起動できないことを実機
  確認した（reports/82）。wined3d（OpenGL）のままGPUを使うことで解消する。
- 低速録画は選択肢として有効だが、th15を`SLOW_MOTION_SUPPORTED_GAME_IDS`には
  **登録しない**。自宅ワーカー（GPU非搭載）への振り分けも行わない
  （`apps/api/src/workerRouting.ts`の`GAME_ROUTING_POLICIES.th15.offerToHomeWorker
  = false`）。

## 根拠

- GPU/CPU/低速録画いずれの効果も実機検証済み: touhou-recorder reports/82。
- **運用の単純化を優先した**: th06ncと同じGPU系インスタンス運用に揃えることで、
  「タイトルによって自宅ワーカーへオファーするかどうか・低速録画を提供するかどうかが
  変わる」という条件分岐を増やさずに済む。GPU系インスタンス（$0.05〜0.08/h）は
  CPU系の`.4xlarge`帯（th20、$0.12〜0.18/h）より安価なため、コスト面でも不利にならない。
  この判断はユーザー（プロダクトオーナー）による意思決定であり、技術的な必然性による
  ものではない。

## 採らなかった選択肢

- **低速録画で対応する（th20と同じ運用）**: 実機検証で有効性は確認済みだが、
  「自宅ワーカーが空いていれば低速録画、いなければCPU系EC2で等倍録画」という
  th20と同じ2段構えの分岐をth15にも導入することになり、運用パターンが増える。
  GPU系インスタンスの方が安価であることも踏まえ見送った。
- **CPUインスタンスのまま提供し、Extraステージの処理落ちを既知の制約として許容する**:
  通常ステージ（Hard）は既に良好な品質のため選択肢として検討したが、Extraステージの
  処理落ちは動画のゲーム内fpsカウンターに明確に表れる（実測30fps前後）ユーザー
  体験の劣化であり、対策手段(GPU・低速録画)が両方とも実機で有効と確認できている
  以上、既知の制約として残す理由が無いと判断した。

## 影響範囲

- `packages/shared/src/gpuRecording.ts`（`GPU_RECORDING_GAME_IDS`）。
- `apps/api/src/ec2.ts`（`getCandidateInstanceTypes`）・`workerRouting.ts`
  （`GAME_ROUTING_POLICIES`）・`packages/shared/src/cost.ts`（`sizeClassOfGame`）。
- `worker/record_th15.py`（`gpu_display=True`、`dxvk_dll_overrides`未指定、
  `crtc_mode="1280x960"`）。
- 将来th15を低速録画・自宅ワーカー対応させたくなった場合は、この決定を見直した上で
  `SLOW_MOTION_SUPPORTED_GAME_IDS`・`GAME_ROUTING_POLICIES`を変更すること
  （MOD側の低速録画フックはth20から踏襲済みのため実装済み、reports/82で動作確認済み）。
