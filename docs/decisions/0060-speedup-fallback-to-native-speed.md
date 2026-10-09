# 0060. GPUを確保できない倍速録画ジョブは`options.recordingSpeed`を1へ書き換えて等倍(CPU)へ落とす

- **状態**: 有効
- **決定日**: 2026-10-09
- **対象**: packages/shared / apps/api / apps/web
- **関連**: Issue #289、#288、`docs/decisions/0056-gpu-vcpu-lease-and-queue.md`、
  `docs/decisions/0058-speedup-recording-on-gpu-instances.md`

GPU必須タイトル（th06nc・th15・th20）以外の倍速録画ジョブは、GPU待ち行列で30分待つか、
GPU起動が3回目以降の試行で容量不足になったら、**ジョブレコードの`options.recordingSpeed`
そのものを1へ書き換えて**等倍（CPU系EC2か自宅ワーカー）へ回す。元の速度は
`requestedRecordingSpeed`に残す。ステートマシンには手を入れていない。

## 背景

倍速録画（`0058`）の導入で、2倍速以上を選んだジョブはすべて`g6f.2xlarge`のスポットで
録る。eu-south-2のG系スポットは在庫が長期間枯渇することがあり（`0055`・`0057`）、その間は
GPU待ち行列のタイムアウト（120分、`gpu_queue_timeout`）か、容量不足のリトライ枯渇
（10回≒27分、`capacity_exhausted`）で失敗していた。CPU系タイトルの倍速録画は等倍なら
CPU系インスタンスや自宅ワーカーで録れるので、失敗させる理由が無い。

## 決定

- **フォールバック可否**: `canFallBackToNativeSpeed(job)`（`packages/shared/src/gpuRecording.ts`）。
  倍速録画で、かつ`GPU_RECORDING_GAME_IDS`に含まれないタイトル。
- **発動条件は2つ**（定数は同ファイル）:
  1. `AcquireGpuSlot`（`handlers/sfn/acquireGpuSlot.ts`）で待つことになり、かつ待機エピソードの
     経過（`gpuQueueEnteredAt`起点）が`SPEEDUP_FALLBACK_QUEUE_WAIT_MINUTES`（30分）以上。
     **枠を確保できなかった分岐でだけ判定する**——ちょうど枠が空いた周回で倍速を捨てないため。
     フォールバックしたら待機列から（`gpuQueuedAt`ごと）外し、`acquired: true`を返す。
  2. `HandleFailure`（`handlers/sfn/handleFailure.ts`）で、容量不足（`isCapacityFailure`、
     Issue #282と同じ判定）の失敗が`SPEEDUP_FALLBACK_CAPACITY_FAILURE_ATTEMPT`（3）回目以降の
     試行で起きた。フォールバックしたら試行回数の上限に関係なく`shouldRetry: true`を返す
     （1ジョブ1回きりなので上限超過も高々1回）。
- **フォールバックの実体**は`jobs.ts`の`fallBackToNativeSpeed()`。`options.recordingSpeed=1`・
  `requestedRecordingSpeed`・`speedupFallbackReason`を、速度が元のまま・未フォールバック・
  未停止・非終端を条件に1回のUpdateItemで書く。GPU要否（`requiresGpuRecording`）・自宅
  ワーカーへのオファー（`workerRouting.ts`）・`FPS_LIMIT_TARGET_HZ`/`GPU_WORKER`
  （`workerEnv.ts`）・コスト帯（`cost.ts`）はすべて`options.recordingSpeed`から導かれ、
  `AcquireGpuSlot`も`Launch`も毎回ジョブを読み直すので、**書き換えた瞬間に以降の全段が
  等倍のジョブとして扱う**。
- **表示**: `GET /jobs/{id}`の`recordingSpeed`は書き換え後の実際の速度（1）、
  `requestedRecordingSpeed`が元の速度。ジョブページはこれが non-null のとき「混雑のため
  通常の速度での録画に切り替えた」と出す（完了後も残す）。ETA・進捗は`recordingSpeed`から
  計算しているので自動的に等倍の見積もりになる。
- **管理画面の再実行**（`admin/retryJob.ts`の`buildRetryJob()`）はフォールバック関連の属性を
  引き継がず、`options.recordingSpeed`を`requestedRecordingSpeed`へ戻す。

## 根拠

- 30分: 倍速録画を選ぶ動機は早く仕上がることで、2倍速でも録画時間は等倍の52〜54%
  （touhou-recorder reports/89）。典型的な尺（10〜30分）なら、30分待ってなお枠が空かない
  時点で等倍で録り始めたほうが早く仕上がる見込みが高い。
- 3回目: 容量不足の試行は`CreateFleet`が即失敗し`WaitBeforeCheck`（3分）を挟むだけなので、
  約6〜9分で見切ることになる。1〜2回の失敗はAZ間の一時的な在庫の偏りで解消しうる。
- チェックポイントとの整合: 生動画チェックポイントには録画時の実時間スケールがS3メタデータ
  として添えてあり（`worker/entrypoint.py`の`read_checkpoint_metadata()`）、再開時は環境変数
  ではなくこちらを使う。前の試行が倍速で録った生動画を残したままフォールバックしても、
  等倍のワーカーは正しい速度で配信版へ変換する。

## 採らなかった選択肢

- **ステートマシンに`FallBackToNative`のような分岐を足す。** `0056`が`requiresGpu`を
  ステートマシンのinputに載せなかったのと同じ理由（デプロイ中の飛行中の実行との互換性）で、
  判定はLambda内に閉じる。ジョブレコードを書き換えるだけで既存の分岐がすべて正しく動くので、
  ステートマシンを触る必要自体が無い。
- **フォールバック先の速度を別フィールド（例: `effectiveRecordingSpeed`）に持つ。**
  `recordingSpeedOf(job.options)`を読んでいる箇所（`0058`の「影響範囲」）を全部書き換える
  必要があり、1箇所でも漏れるとGPU経路・ワーカーの倍率がずれる。`options`を書き換えれば
  読む側は何も変えなくてよい。
- **GPU待ち行列のETAで即座に判断する（例: 推定待ち時間が等倍で録るより長ければ落とす）。**
  ETAはリースの`expectedFinishAt`（尺からの粗い推定）に依存し、外れたときに「すぐ空いたのに
  等倍で録った」になる。実際に待った時間なら誤判定が無い。
- **容量不足の連続回数を専用の属性で数える。** 試行回数での代用で十分（3回目以降のGPU試行が
  さらに容量不足で落ちたなら、それ以前の失敗が何であれGPUに拘る理由は薄い）。
- **フォールバックせず従来どおり失敗させ、ユーザーに等倍での再アップロードを促す。**
  メール認証からやり直しになり、「迷わず使える」（AGENTS.md §1）に反する。

## 影響範囲

- `options.recordingSpeed`は**ジョブの途中で変わりうる**。ジョブ作成時の値を前提に
  キャッシュ・転記するコード（例: Step Functionsのinputへ載せる）を書かないこと。
- 倍速録画にGPU必須でない新しい経路（例: 自宅ワーカーにGPUを載せる）を足すときは、
  `canFallBackToNativeSpeed()`と発動条件を見直すこと。
- `JobRecord`に「結果側」のフィールドを足す場合と同様、フォールバック関連の属性を増やしたら
  `buildRetryJob()`の除外リストも更新すること。
