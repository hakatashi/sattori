# 0075. 技術検証は「実験ジョブ」と検証用ECRで本番パイプラインに乗せる

- **状態**: 有効
- **決定日**: 2026-11-21
- **対象**: apps/api / packages/shared / infra / docs
- **関連**: Issue #397、Epic #399、#72（ステージング環境）、[`0002`](0002-ec2-launch-at-runtime-not-iac.md)、
  [`0005`](0005-admin-auth-ssm-shared-token.md)、[`0066`](0066-recording-fallback-plan-as-config.md)、
  [`0074`](0074-import-touhou-recorder-snapshot.md)、`docs/runbooks/experiment-workflow.md`

クラウドでの技術検証は、管理API（`POST /admin/experiments`）で**段を明示した実験ジョブ**を本番と同じ
Step Functionsに流して行い、検証用のワーカーイメージは**本番とは別のECRリポジトリ**に置く。
手作業でEC2・SG・キーペア・ECRを作る検証（touhou-recorderの `cloud/terraform`）はやめる。

## 背景

- touhou-recorder（TR）でのクラウド検証は手順が確立せず、毎回手作業（terraform・SG・キーペア・ECR）で環境を
  作っていた。同じAWSアカウント・リージョン（eu-south-2）でCDKのデプロイと並走するので、競合のおそれもあった。
- 本番のECR（`sattori-worker`・`-gpu`）は**2イメージしか保持しない**ため、検証用タグを押すと本番のイメージが
  消えて全ジョブが失敗しうる（`deploy-sattori` skill §1）。検証用タグのpushは禁止していた。
- 目指す形は「検証は本番パイプラインに直接変更を加えて行い、合格したらすぐ本番に取り込める」こと。

## 決定

1. **実験ジョブ**: `JobRecord.experiment`（`ExperimentSpec`: 段・`workerImageTag`・`note`）を持つジョブ。
   - 管理API（`POST /admin/experiments`、Authorizer配下）が、リプレイ（`sourceJobId`、または`replayKey`＋`game`）と
     **1つの段**（`kind`・`platform`・`region`・`instanceTypes`・`captureMode`・`speed`）を受けて`queued`で作り、
     通常のジョブと同じStep Functionsを起動する。
   - 段の読み取りは`recordingPlanOf(job)`に一本化した。実験ジョブは**タイトルの段（`RECORDING_PLANS`）の代わりに
     指定の1段だけ**を試し、その段を使い切ったら（Spot在庫の枯渇など）ほかの段へ落ちず`capacity_exhausted`で失敗する
     （どの条件で録れたかを曖昧にしないため）。
   - 孤児の掃除（タグ`sattori:jobId`）・コスト推定・ワーカーログ・進捗プレビュー・緊急停止・再実行は通常のジョブと共通。
   - **完了メールは送らない**（`email`がnull。`sendCompletionEmail`はemailの無いジョブを飛ばす）。
   - マジックリンクのレート制限と月間コストガードは通らない（管理者専用）。キルスイッチは`Launch`側で効く。
   - **GPUの待ち行列での優先度は付けない**（通常のジョブと同じFIFO）。検証が一般のジョブを追い越すと、
     ユーザーの待ち時間が検証の都合で伸びるため。GPUが混んでいる間は待つ。
   - 一覧は`GET /admin/jobs`の各行に`experiment`が載り、`GET /admin/experiments`が実験ジョブだけを
     結果つき（品質の判定値`desyncDetected`・`timedOut`、実時間、尺比、課金時間、推定コスト）で返す。
2. **検証用ECR**: `sattori-worker-experimental`（CPU）・`sattori-worker-experimental-gpu`をCDKで作る
   （4世代保持、タグ無しは1日で削除）。ワーカーのEC2ロールにpull権限を付ける。
   実験ジョブが`workerImageTag`を指定したときだけ、`launchTierFor`がそのリポジトリのイメージを使う。
   **`workerImageTag`は一次リージョン（eu-south-2）のEC2の段でだけ使える**（検証時にAPIが400で弾く）。
3. **自宅ワーカー**: 検証用イメージは使わない（`workerImageTag`と自宅の段は併用不可）。自宅デーモンの
   pull対象（`WORKER_IMAGE`）は本番のイメージ固定で、検証のたびに自宅の常駐デーモンを切り替えると
   本番ジョブの受付を止める。自宅マシンでの検証は`verify-recording-locally` skill（ローカルのDocker）で行う。
   自宅の段そのもの（本番のイメージ）は実験ジョブでも指定できる。
4. **GPUのAMI**: 検証用AMIは作らない。AMIの検証は従来どおりus-west-2へコピーして行う（`build-gpu-worker-ami` skill）。
   新しいGPUインスタンスタイプを実験ジョブで試すときは、先に`GPU_INSTANCE_TYPE_VCPUS`へ足す（vCPUリースの会計に要る）。
5. **#72（ステージング環境）との関係**: 検証の目的では、ステージング環境（もう1組のスタック）は作らず、この実験ジョブで
   足りる。別スタックはコストと保守が二重になるうえ、本番と違う構成での結果になる。ステージングが要る別の理由
   （フロントの確認など）が出たときは#72で判断する。

## 根拠

- 検証と本番が同じ経路（Step Functions・Launch Template・IAM・孤児掃除）を通るので、結果がそのまま本番の挙動の
  証拠になる。手作業のSG・キーペアは要らず、課金の取りこぼし（孤児）も10分間隔の掃除で拾える。
- 検証の切り替えを「起動側が渡す環境変数（段の属性）」で表すので、ワーカーの中に「実験か本番か」の分岐を作らずに済む
  （AGENTS.md §3、[`0010`](0010-slow-motion-no-worker-side-branching.md)）。
- 本番のリポジトリに検証用タグを押す必要が無くなり、2イメージ保持の制約と衝突しない。

## 採らなかった選択肢

- **本番ECRに検証用タグを押す**: 2世代保持で本番のイメージが消える。保持数を増やすと本番のストレージ費が増える。
- **実験ジョブにもタイトルの段のフォールバックを使う**: 1段の条件で録れたかが曖昧になる。段を明示して失敗させる。
- **実験ジョブをGPU待ち行列で優先する／後回しにする**: 前者は一般ユーザーを遅らせる。後者は検証が終わらない。
  どちらも現状のGPU需要では要らず、FIFOで足りる。
- **検証用ECRをeu-north-1へ複製する**: 検証のたびに複製の到着待ちが入る。フォールバック先で試すGPU検証は
  本番イメージ（レプリカ済み）で足りる。
- **検証用ステージングスタック（#72）**: 上記のとおり二重のコスト。
- **自宅デーモンに検証用イメージを引かせる**: 自宅は本番ジョブを受け続けるので切り替えられない。

## 影響範囲

- `packages/shared/src/experiment.ts`・`recordingPlan.ts`（`recordingPlanOf`）、`apps/api/src/experiments.ts`・
  `ec2.ts`（`launchTierFor`の第4引数）・`handlers/admin/createExperiment.ts`・`listExperiments.ts`、
  `infra/lib/sattori-stack.ts`（ECR・IAM・ルート）。仕様は[`apps/api/docs/admin-api.md`](../../apps/api/docs/admin-api.md) §10。
- **段を読むコードは`recordingPlanFor(job.game)`ではなく`recordingPlanOf(job)`を使うこと**（使うと実験ジョブが
  自分の段ではなくタイトルの段で動く）。
- 管理設定の`skipGpuSteps`・`forceGpuFallbackRegion`（`recordingSteps.ts`）は実験ジョブの段にも効く。GPUの段を指定する
  実験の前に、これらが無効なことを確かめる。
- 運用の手順は[`docs/runbooks/experiment-workflow.md`](../runbooks/experiment-workflow.md)。
