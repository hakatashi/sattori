# 0063. Spot在庫の枯渇はジョブの中で永続エラーとして扱い、待たずに次の段へ進む。全段が尽きたら直ちに失敗させる

- **状態**: 有効
- **決定日**: 2026-11-04
- **対象**: apps/api / packages/shared / infra / apps/web
- **関連**: Issue #315、#316、#317、[`0056`](0056-gpu-vcpu-lease-and-queue.md)・[`0060`](0060-speedup-fallback-to-native-speed.md)・[`0061`](0061-gpu-capacity-fallback-to-eu-north-1.md)

起動手段を順序付きの段（`launchTiersFor()`）で表し、段の全サブネット・全候補がSpot在庫の枯渇で
失敗したら、その段を`JobRecord.capacityExhaustedTargets`へ記録して同じ`Launch`の中で次の段へ進む。
記録した段は同じジョブのリトライで試さない。全段が尽きたジョブは、等倍へ落とせなければ`Launch`が
その場で`failed`（`capacity_exhausted`）にする。0060の「3回目の容量不足で等倍へ」と、0061の
「リトライでは毎回eu-south-2から試す」を置き換える。

## 背景

容量不足の例外はステートマシンのCatchから`WaitBeforeCheck`（3分）を経て`HandleFailure`へ進み、
毎回eu-south-2から試し直していた。実測では、倍速録画が等倍へ落ちて録画を始めるまで約10分、GPU必須
タイトルは約30分待って`capacity_exhausted`で失敗していた。ところが枯渇は数分では解消しない。
10/11以降の`capacity_exhausted`28件のうち、次にGPUが起動するまで回復した19件で中央値約13時間・
最大115時間かかり、9件は調査時点で未回復だった（Issue #315）。3分おきの再試行は待ち時間を増やす
だけになっていた。

## 決定

- **段**（`apps/api/src/ec2.ts`の`launchTiersFor()`）: GPUジョブは`gpu:<eu-south-2>`→`gpu:<eu-north-1>`、
  CPU系は`cpu:<eu-south-2>`の1段。#316で段を足す前提の土台。
- **容量不足の判定**（`isTierCapacityExhausted()`）: 1台も確保できず、`Errors`が全件
  `SPOT_CAPACITY_ERROR_CODES`で、全サブネット×全候補の失敗が報告されているときだけ。
- **失敗の3分類**（`launchRecordingInstance()`）:
  - 段を使い切った: 記録して次の段へ。
  - Spot在庫の枯渇とクォータ超過などが混ざった: 記録せず次の段へ（0061までの動作）。次の段も
    尽きたら従来どおりステートマシンのリトライに回す。
  - Spot在庫の枯渇を1件も含まない（`VcpuLimitExceeded`・API障害など）: 次の段へ進まず従来どおり
    リトライに回す。
- **全段が尽きたとき（A案）**（`handlers/sfn/launch.ts`）:
  - 倍速録画（GPU必須タイトルを除く）: 等倍へ書き換えてGPUリースを返却し、同じ呼び出しの中で
    自宅ワーカーへのオファーとCPU系の起動をやり直す。
  - それ以外: GPUリースを返却してジョブを`failed`（`capacity_exhausted`）にし、例外を投げる。
    Catchの先の`WaitBeforeCheck`（3分）は残るが、ユーザーにはこの時点で失敗が見える。
    `HandleFailure`は`status`と`errorCode`を見て、後始末だけしてリトライしない。
- **クォータ超過の扱いは変えない**。台帳のずれが原因で次のリージョンでは解消しないため。この失敗での
  等倍フォールバック（`SPEEDUP_FALLBACK_QUOTA_FAILURE_ATTEMPT`=3回目以降）も`HandleFailure`に残す。
- **待ち行列の30分での等倍フォールバック（0060）は変えない**。
- **`fallBackToNativeSpeed()`の条件を`failed`でも通す**（`done`・緊急停止だけ弾く）。ワーカーが書く
  `failed`のままリトライ中のジョブは、起動に成功するまで`status`が`failed`のままで、弾くと等倍へ落ちず
  全段スキップのまま試行回数を使い切っていた。
- **Launch Templateのバージョンは試行ごとに消す**（`deleteLaunchTemplateVersion()`）。
- **案内文を見直す**。枯渇は数日続くことがあるので「一時的な混雑」とは書かず、回復に数時間から数日
  かかりうると伝える（`errors.capacity_exhausted`、`CAPACITY_EXHAUSTED_MESSAGE`）。

## 根拠

- **段の判定材料**: 直近45日のLaunchFnのログでは、`CreateFleet`の`Errors`はサブネットごとに1件ずつ
  返っていた（eu-south-2は3件、eu-north-1は2件）。`MaxSpotInstanceCountExceeded`との混在も実在する。
  2026-11-04に起動しない価格（`MaxPrice`）の使い捨てリクエストで、2タイプ×3サブネットに6件の
  `LaunchTemplateAndOverrides`付きエラーが返ることも確認した（エラーコードは`InvalidParameterValue`で、
  容量不足のレスポンスの形そのものではない）。組み合わせの報告が欠ければ使い切りと判定せず、従来どおりの
  リトライになる（安全側）。
- **CPU系ジョブも同じ扱いにする理由**: 同じ45日で`create_fleet_failed`のCPU系ジョブは0件。実害の
  見込みが無く、分岐を増やす理由が無い。
- **ステートマシンを変えない理由**: 実行中のジョブは旧定義のまま新しいLambdaを呼ぶので、Lambdaの中で
  閉じれば互換性の問題が起きない（0056・0060と同じ判断）。`capacityExhaustedTargets`が無い実行中の
  ジョブは、記録なしとして動く。
- **時間**: GPUの2段（`CreateFleet`約2秒ずつ）+ オファー20秒 + CPUの起動で約30秒と見積もり、
  `LAUNCH_LAMBDA_TIMEOUT_SECONDS`（60秒）に収まる。追加ぶんは`LAUNCH_OVERHEAD_RESERVE_SECONDS`
  （20秒）の内側で、`MAX_OFFER_WINDOW_SECONDS`の前提は変わらない。本番での実測はまだ無い。
- **バージョン数**: 上限は1テンプレートあたり10,000（[AWSのドキュメント](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/launch-template-restrictions.html)）で、
  2026-11-04時点でGPU用912、eu-north-1 433、CPU用248。使い捨てのテンプレートで、最新のバージョンを
  消すと`$Latest`は残りの最新を指し、次の作成は番号を再利用せず、残ったバージョンの内容を継承することを
  確認した（[`0051`](0051-launch-template-source-version-latest-not-default.md)の`$Latest`継承は壊れない）。

## 採らなかった選択肢

- **B案: 全段が尽きたら記録を消し、間隔を空けて待ち続ける。** 回復までの実績（中央値約13時間）を
  踏まえ、Issue #315でユーザーがA案（直ちに失敗させる）を選んだ。
- **ステートマシンに全段枯渇用の分岐を足し、`WaitBeforeCheck`を飛ばす。** 3分の待機はジョブが
  終端した後なのでユーザーから見えず、実行中のジョブとの互換性を検討する価値が無い。
- **`HandleFailure`で失敗を確定する。** 失敗の表示が3分遅れ、その間GPUリースも塞がる。
- **`HandleFailure`の等倍フォールバックを完全に消す。** クォータ超過が続く倍速録画が、等倍で
  録れるのに失敗するようになる。
- **`HandleFailure`の容量不足判定に`LaunchTiersExhaustedError`を足す。** 全段枯渇のジョブは`Launch`が
  確定させるか等倍へ落とすので、`HandleFailure`へ来るのは緊急停止か完了の競合だけで、判定を使う場面が無い。
- **`status === "failed"`だけでリトライを止める。** ワーカーが書く`failed`はSpot中断以外でも
  リトライの対象なので、`errorCode`も見る必要がある。
- **成功した試行のバージョンを残して定期的に掃除する。** 消す役を別に持つ理由が無い。インスタンスの
  起動後にバージョンは参照されない。

## 影響範囲

- 段を足すとき（#316）は`launchTiersFor()`に足す。段の`id`はジョブレコードに残るので、意味を変えないこと。
- `JobRecord`の`capacityExhaustedTargets`は`buildRetryJob()`で引き継がない。管理画面の再実行は全段を試し直す。
- `status="failed"`・`errorCode="capacity_exhausted"`のジョブで`HandleFailure`は必ず止まる。この組を
  再試行したいジョブに書かないこと。
- 全段枯渇の間は、GPU必須タイトルが待ち時間なしで失敗する（`docs/known-limitations.md` §5）。
- この変更より前に作られたバージョン（上記の合計約1,600件）は残っている。上限まで十分遠いので消していない。
