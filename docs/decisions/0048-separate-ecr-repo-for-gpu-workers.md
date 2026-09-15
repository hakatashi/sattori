# 0048. GPU描画必須タイトル専用の別ECRリポジトリ（worker-gpu）を新設する

- **状態**: 有効
- **決定日**: 2026-09-12
- **対象**: infra / worker / apps/api
- **関連**: Issue #241、`docs/decisions/0046-gpu-ec2-instance-and-fixed-ami.md`

GPU描画必須タイトル（th06nc等）専用に、既存の共通ワーカーイメージ（`sattori-worker`）
とは別のECRリポジトリ（`sattori-worker-gpu`）を新設する。別Dockerfile
（`worker/Dockerfile.gpu`）からビルドし、CPU系ワーカーのデプロイに影響を与えない
独立したライフサイクルで管理する。

## 背景

既存の`worker/Dockerfile`（`sattori-worker`イメージ）はタイトル数に依存しない
共通部分のみで構成されており（Issue #22、タイトル固有アセットはS3へ分離済み）、
新タイトル追加時にイメージを再ビルドする必要はない設計だった。

th06nc（GPU描画必須、Issue #241）はこの前提から外れる——依存パッケージ
（wine64のみ・Xorg関連・libvulkan1等）がCPU系タイトル（wine32/64両方・Mesa
ソフトウェアレンダリング関連）と大きく異なり、同じイメージに混ぜるとCPU系
タイトルのビルドにも影響する変更が増える。また、GPUベースイメージは将来
NVIDIA関連の依存が増える可能性があり、CPU系イメージのサイズ・ビルド時間に
影響を与えたくない。

## 決定

- `worker/Dockerfile.gpu`を新設し、GPU描画必須タイトル専用の依存パッケージ
  （wine64・Xorg関連・libvulkan1等）のみを含める。`recording/`パッケージ・
  `entrypoint.py`・各`record_thNN.py`は既存Dockerfileと共通のソースをCOPYする。
- `infra/lib/sattori-stack.ts`に`workerGpuRepo`（ECRリポジトリ`sattori-worker-gpu`）
  を新設し、既存`workerRepo`とは独立した`lifecycleRules`（`maxImageCount: 2`、
  同方針）を持たせる。
- `apps/api/src/config.ts`に`workerGpuImage`を追加し、`ec2.ts`の`buildUserData()`
  が`requiresGpuRecording(job.game)`でどちらのイメージ・ECRリポジトリを使うか
  分岐する。
- ビルド・pushの手順は`deploy-sattori` skillに追記し、CPU系タイトルの変更では
  GPU系イメージの再ビルドが不要であることを明記する（逆も同様）。
- 今回はth06ncのみを収録するが、将来th20等の既存CPU系タイトルをGPU化する場合の
  受け皿としても使える構造にする（`GPU_RECORDING_GAME_IDS`に追加するだけで
  切り替えられる）。**ただし今回はth20の録画経路を一切変更しない**（スコープ外）。

## 根拠

- CPU系9タイトルの既存デプロイフロー（イメージ1本・タイトル数非依存）を崩さない
  ことが、Issue #22の設計意図（ECRストレージコストの抑制、タイトル追加時の
  再ビルド不要）と整合する。
- GPU系・CPU系で依存パッケージの重なりが小さく、共通化するメリットが薄い
  （wine32/64の混在 vs wine64のみ、Mesaソフトウェアレンダリング vs
  Xorg+Vulkan等）。

## 採らなかった選択肢

- **既存`worker/Dockerfile`にGPU系の依存を追加し、1イメージで両対応する**:
  イメージサイズの肥大化・ビルド時間の増加がCPU系9タイトルのデプロイにも
  波及する。また、GAME環境変数による実行時分岐だけでなく、Dockerイメージの
  ビルド時点で依存パッケージが競合・肥大化するリスクがあり、既存の「ワーカー
  イメージはタイトル数に依存しない」という設計原則（Issue #22）とも整合しない
  ため見送った。

## 影響範囲

- `worker/Dockerfile.gpu`（新規）。
- `infra/lib/sattori-stack.ts`（`workerGpuRepo`・IAM権限・`commonEnv`の
  `WORKER_GPU_IMAGE`）。
- `apps/api/src/config.ts`・`ec2.ts`（GPU系イメージの分岐）。
- `.claude/skills/deploy-sattori/SKILL.md`（ビルド・pushの手順）。
- 将来GPU系タイトルを追加する場合、`worker/Dockerfile.gpu`側の依存パッケージを
  見直すこと（タイトルごとに個別のDockerfileを増やすのではなく、GPU系1本に
  まとめる方針を維持する）。
