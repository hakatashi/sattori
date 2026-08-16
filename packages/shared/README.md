# @sattori/shared

フロントエンド（`apps/web`）とバックエンド（`apps/api`）が共有する型定義。
録画ワーカー（`worker/`、Python）はこのパッケージに依存しない（DynamoDB
スキーマとして間接的に同じ形を参照するのみ）。

## API 契約（`src/api.ts`）

| メソッド・パス | 用途 |
| --- | --- |
| `POST /uploads` | 署名付きアップロードURL発行（キーはサーバー採番、`.rpy`・サイズ検証） |
| `POST /replays/parse` | アップロード済みリプレイの解析（ページAのプレビュー用） |
| `POST /magic-links` | マジックリンクメール送信要求。この時点で `status: "pending"` の
  `JobRecord` を作成する（Step Functionsはまだ起動しない）。同一メール（`+`エイリアス
  正規化後）は24時間5件までのレート制限あり（`apps/api/README.md` 参照） |
| `POST /jobs/{jobId}/start` | ジョブページ（メールのリンク先）アクセス時の録画起動要求。
  認可は `jobId` のみで行う（`jobId` 自体がメールを確認しないと分からない秘密値）。
  `pending`→`queued`をDynamoDBの条件付き更新で原子的に遷移させ、Step Functions
  実行を開始する。同一jobIdへの複数回呼び出しは最初の1回のみ起動し、以降は現在の状態を
  冪等に返す |
| `GET /jobs/{jobId}` | ジョブ状態取得（ポーリング用）。完了時に CloudFront のDL URL、
  進行中は現在フェーズ内で実際に処理が完了した秒数(`progress`。全体に対する割合では
  ない)とプレビュー画像URL(`previewImageUrl`)も返す。低速録画で走るかどうか
  (`slowMotion`)も返す（後述） |
| `GET /worker-availability` | 常駐ワーカー（自宅ワーカー、Issue #49）の空き状況。
  ページAが詳細設定の「低速録画」を有効化してよいかの判定にだけ使う。**認証なしで
  公開されるため`workerId`・台数・負荷は返さない**（開発者の自宅環境の稼働状況を
  必要以上に外へ出さない）。あくまで「今の」状態で、実際に録画が始まるのはユーザーが
  マジックリンクを開いた後（最大24時間後）なので、可否は一致しない前提 |
| `POST /beacon` | Cookie無しの計測ビーコン（`src/analytics.ts`、Issue #142）。
  pageview/parse_errorイベントを送る。`apps/web`は`API_BASE`を経由しない固定の
  相対パスで叩く（CloudFront経由で`CloudFront-Viewer-Country`を得るため、
  `infra/README.md`）。収集する情報と「あえて集めないもの」は
  [`docs/decisions/0024`](../../docs/decisions/0024-cookieless-analytics-beacon.md) |

`EMAIL_PATTERN`（簡易メール形式チェック）はフロントエンドとバックエンドの両方が
同じ判定基準を使うようここに一本化してある。

## ジョブ状態機械（`src/job.ts`）

```
pending → queued → launching → recording → converting → done | failed
```

- `pending`: マジックリンク送信済み・ジョブページへのアクセス（録画起動）待ち。
  24時間（bot/濫用対策としての期限。アップロード用S3の自動削除とは独立）以内に
  起動されなければ受付期限切れとして扱う（`JobRecord.pendingExpiresAt`）。
- `queued` 以降はワーカー・Step Functionsが書き込む。`converting` は録画完了
  （生動画チェックポイントアップロード済み）〜配信用変換〜出力アップロード完了までを指す。
- `isTerminalStatus()` が `done`/`failed` を終端状態として判定する（フロントエンドの
  ポーリング停止判定に使用）。

`JobRecord`（DynamoDB `JobsTable` の1アイテムに対応する型）は状態そのものに加え、
`instanceId`/`instanceType`/`availabilityZone`（実際に確保されたEC2インスタンスの
運用調査用データ、ユーザー向けAPIには含めない）、`replayInfo`（解析済みリプレイ内容の
転記、ページBでの表示用）、`retriedToJobId`/`retriedFromJobId`（管理画面からの
再実行で複製された元ジョブ⇄新ジョブの相互リンク、Issue #59）、
`launchedAt`/`spotPricePerHour`/`outputBytes`/`outputBytes720p`（コスト推定の入力、
Issue #60。後述「コスト推定」）、`workerKind`/`assignedWorkerId`ほか自宅ワーカー関連
（Issue #49。後述「ワーカーの種別と自宅ワーカー」）、`errorCode`（`error`と同時に
書き込む機械可読コード。`apps/web/src/i18n/apiErrors.ts`が`errors.<code>`翻訳の軸に
使う、Issue #138）等を持つ。フィールドごとの詳細はソースのコメントを参照。

> **`JobRecord`にフィールドを足すときの注意**: `apps/api`の`requestMagicLink.ts`
> （新規作成）と`admin/retryJob.ts`の`buildRetryJob()`（再実行時の複製）の両方が
> 全フィールドを明示的に埋めるため、型エラーとして必ず気付ける。ただし
> `buildRetryJob()`は元ジョブをスプレッドで引き継ぐので、**実行結果に属する
> フィールド（出力・インスタンス情報・時刻）は明示的にnullへ初期化すること**
> （引き継ぐと新ジョブが元ジョブの結果を持ったまま起動する）。特に
> `homeWorkerOfferState`はsparse GSIのキー属性なので、引き継ぐと新ジョブが起動前から
> 「オファー中」としてインデックスに載り、自宅ワーカーに横取りされる。また
> `stopRequestedAt`（緊急停止の拒否票）を引き継ぐと、新ジョブのワーカーがstatusを
> 1つも書けなくなり、録画が完走しても`queued`のまま固まる。

## ワーカーの種別と自宅ワーカー（`src/worker.ts`、Issue #49）

録画ジョブを実行するのは EC2 Fleet（`workerKind: "ec2"`）か開発者の自宅サーバー
（`"home"`）のどちらかで、**どちらも同じECRイメージ・同じtaskToken契約**で動く。
自宅マシンはNAT配下でAWS側から到達できないため、割り当てはPull型:

- `WorkerHeartbeat`: `WorkersTable`の1アイテム。自宅の常駐デーモンが15秒ごとに
  自身の空き状況・対応タイトル・追加能力（`WorkerCapability`）を自己申告する。
  `isHeartbeatFresh()`が新鮮さ（45秒以内）を判定し、**新鮮でなければAWS側は
  オファー自体を行わない**（＝自宅が落ちている平常時に録画開始が遅れない）。
  未来方向のずれも同じ幅までしか許容しない（時計が進んだ止まったデーモンへ
  オファーが吸い込まれ続けるのを防ぐため）。
- `JobRecord`のオファー/claim関連フィールドは**`| null`ではなく optional**にしてある。
  DynamoDBのNULL型はGSIのキー属性として不適合で、「属性が無い」ことをそのまま
  条件式（`attribute_not_exists`）で表現したいため。
- `WorkerCapability`に定義があること自体は「実装済み」を意味しない（能力の宣言は
  デーモン側の設定で行う）。`slow-motion-recording`は低速録画（Issue #68、後述）。

## 低速録画（`src/slowMotion.ts`、Issue #68）

ゲームを 1/2 倍速で走らせて録画し、後処理で等倍へ戻す方式。等倍では処理落ちして
品質を担保できない th20（Issue #87）のための手段で、ユーザー向けの呼称は「低速録画」。
フロントエンド・API・ワーカーが同じ定数を参照するためここに一本化してある。

- `SLOW_MOTION_TARGET_HZ`（30）: ワーカーへ`FPS_LIMIT_TARGET_HZ`として渡る値。
- `SLOW_MOTION_TIME_SCALE`（2）: 録画フェーズが実時間で何倍かかるか。ジョブページの
  進捗バジェット（`apps/web/src/hooks/jobProgressBudget.ts`）と録画のハードタイム
  アウト（`worker/recording_common.py`）が同じ係数を使う。
- `SLOW_MOTION_DEFAULT_GAME_IDS`（th20のみ）/ `defaultSlowMotionFor()`: 既定でオンに
  するタイトル。**自宅ワーカーが使えなければ常にfalse**（そもそも選べないため）。
- `isSlowMotionRecording(options, workerKind)`: **`options.slowMotion`はユーザーの希望に
  すぎない**。オファーが時間内にclaimされずEC2へフォールバックした場合は等倍録画に
  なるため、`workerKind`まで見て「実際に低速録画で走るか」を判定する。割り当てが
  未確定（`null`）の間は低速録画とみなす——ジョブページの残り時間推定が、割り当て確定の
  瞬間に大きく飛ぶのを避けるため。`GET /jobs/{jobId}`の`slowMotion`はこの結果を返す。

**低速録画は自宅ワーカー限定**（EC2では録画時間＝Spot料金が倍になるため）。この制約は
ワーカー側の分岐ではなく、起動側が`FPS_LIMIT_TARGET_HZ`を渡すかどうかで表現する
（`apps/api/src/workerEnv.ts`、
[`docs/decisions/0010`](../../docs/decisions/0010-slow-motion-no-worker-side-branching.md)）。

契約の詳細と運用は`apps/api/README.md`「自宅ワーカーへのジョブ割り当て」・
`home-worker/README.md`を参照。

## リプレイ情報（`src/replay.ts`, `src/games.ts`）

- `ReplayInfo`: `packages/replay-parser` の `ParsedReplay`（ステージ内訳など
  Sattori では使わない情報も含むリッチな型）から、ページA表示・録画メタデータに
  必要な項目だけを抜き出したサブセット。`fromParsedReplay()` が変換を行う。
  replay-parser は単体でOSS公開できるよう Sattori 固有の型に依存しない設計になっているため、
  この変換ロジックは replay-parser 側ではなく shared 側に置く（依存の向きは
  shared → replay-parser の一方向）。
- `parseReplayInfo()`: バイト列から `ReplayInfo` を得るエントリポイント。フォーマット
  解析エラーに加え、`SUPPORTED_GAME_IDS`（`games.ts`。現状 th06/07/08/11）に含まれない
  タイトルも `unsupported_game` エラーとして日本語メッセージ付きで返す。失敗時の
  `ReplayParseFailure.game` は `unsupported_game` の場合のみ検出タイトルを持つ
  （パースエラー計測、Issue #142。`apps/web/src/api/analytics.ts`）。
- `localizedCharacterName()`: 表示言語に応じた自機タイプ名（`characterNameJa`/
  `characterNameEn`。取得できなければ生の `character`）。ページAの解析プレビュー
  （`apps/web`）とメール本文（`apps/api/src/ses.ts`）が同じ表記を出すために共有する。
- `GAME_IDS`/`GAME_TITLES`（`games.ts`）: th06〜th20（th19除く）の識別子と表示用の
  日本語タイトル名。録画対応タイトルは `SUPPORTED_GAME_IDS` で別途絞り込む
  （パーサー対応と録画対応は別軸。詳細は `packages/replay-parser/README.md`）。

## 管理API契約（`src/admin.ts`、Issue #51）

`src/api.ts`とは意図的に別ファイルに分離している。`api.ts`は「ユーザー向け」契約で、
`GetJobResponse`が`email`/`instanceId`等の内部データを意図的に除外しているのに対し、
`admin.ts`は正反対の方針（`AdminJobDetailResponse.job`は`JobRecord`をほぼそのまま返す）
を取るため。管理APIは`/admin/*`のLambda Authorizer（共有トークン）配下にしか
存在しないため、内部データを含めても問題ない前提に立っている。

**唯一の例外が`homeWorkerEnv`**（自宅ワーカーへのオファーに添えるコンテナ環境変数、
Issue #49）。これは生きたStep Functionsの`TASK_TOKEN`——実行を任意に成功/失敗させられる
ベアラ——を含むため、`AdminJobRecord`では`RedactedWorkerEnvironment`（`unique symbol`の
ブランド付き）に狭めてある。`JobRecord`をそのまま代入すると**型エラーになる**ので、
`apps/api`の`toAdminJobRecord()`（内部で`redactWorkerEnv()`を呼ぶ）を通し忘れることは
できない。ブランドを使っているのは、`WorkerEnvironment`が`Record<string, string>`で
あるためインデックスシグネチャが optional プロパティの互換性判定に使われず、
`Omit<..., "TASK_TOKEN">`や`TASK_TOKEN?: undefined`では**何も防げない**から。

| メソッド・パス | 用途 |
| --- | --- |
| `GET /admin/jobs` | ジョブ一覧（新しい順、`status`絞り込み、カーソルページング） |
| `GET /admin/jobs/{jobId}` | ジョブ詳細（`JobRecord`全フィールド＋ダウンロード導線） |
| `GET /admin/jobs/{jobId}/execution` | Step Functions実行の状態・履歴 |
| `GET /admin/jobs/{jobId}/logs` | ワーカーコンテナのCloudWatch Logs（Issue #58） |
| `POST /admin/jobs/{jobId}/stop` | ジョブの緊急停止（Issue #59） |
| `POST /admin/jobs/{jobId}/retry` | ジョブの再実行（Issue #59。**新しいjobIdのジョブとして複製・起動**するため、レスポンスの`jobId`はパスのそれとは別物） |
| `GET /admin/costs` | コスト推定の日次/週次/月次集計（Issue #60。後述「コスト推定」） |
| `GET /admin/settings` | キルスイッチ・月間コストガード閾値の現在値と当月推定コスト（Issue #14。後述「運用設定」） |
| `POST /admin/settings` | キルスイッチ・月間コストガード閾値の更新（Issue #14） |

参照系と違い停止・再実行は状態を変えるため`POST`（`DELETE`にすると
`corsPreflight.allowMethods`の拡張も要る）。再実行の複製元/複製先は
`JobRecord.retriedFromJobId`/`.retriedToJobId`で相互に辿れる。

API側の実装詳細（GSI設計・authorizer・ダウンロードURLの発行方法等）は
[`apps/api/docs/admin-api.md`](../../apps/api/docs/admin-api.md)、フロント側は
[`apps/web/docs/admin-ui.md`](../../apps/web/docs/admin-ui.md)を参照。

## コスト推定（`src/cost.ts`、Issue #60）

管理画面がジョブ単位・期間単位のコストを表示するための**推定ロジックと単価定数**。
ジョブ詳細のコストパネル（フロント）と集計API（Lambda）の両方がこの1本を共有する
（画面ごとに再実装して数字が食い違う事故を避けるため）。

- `estimateJobCost(job, now)`: 1ジョブぶんの内訳（`ec2Spot` / `ebs` / `publicIpv4` /
  `s3Storage` / `misc`）と合計を返す純関数。`now`を引数に取るのは、実行中ジョブの
  推定値をテストで固定できるようにするため。
- 単価は**eu-south-2・2026-08-03時点**（`docs/research/aws-region-cost-analysis.md`。`.4xlarge`帯
  のみ2026-08-12時点）。リージョンを移す場合はここの定数も入れ替える。
- **Spot単価のフォールバックはサイズ帯（`.xlarge`/`.2xlarge`/`.4xlarge`）ごとに持つ**。
  `apps/api/src/ec2.ts`の候補インスタンスタイプに新しい帯を足したら、
  `FALLBACK_SPOT_PRICE_USD_PER_HOUR`と`sizeClassOf()`/`sizeClassOfGame()`にも必ず
  足すこと。帯が抜けると既定の`.xlarge`へ静かに丸められ、推定コストが実額の数分の一に
  なる——この値は月間コストガード（`apps/api/src/costGuard.ts`）の入力でもあるため、
  キルスイッチが効かないまま予算を超過しうる。
- **課金対象時間は`launchedAt`〜終了時刻の実時間**。試行間の待機（`WaitBeforeCheck`の
  3分など）もEC2稼働として数えるため、リトライしたジョブでは**過大側**に出る。
  試行ごとの正確な稼働区間を持つにはLaunch/Terminateの時刻を全試行ぶん記録する必要が
  あり、月1000ジョブ規模の運用把握という目的には割に合わないという判断。
- 値が無い旧ジョブ（`launchedAt`/`spotPricePerHour`/`outputBytes`はIssue #60で追加した
  フィールド）は実績平均・サイズ帯の平均単価へ縮退する。どのフォールバックを使ったかは
  `billedDurationSource`/`spotPriceSource`/`outputSizeUnknown`で返し、**UIが「これは
  仮定だ」と明示できる**ようにしている（推定値を実績として読ませないため）。
- **CloudFrontの配信料だけは`breakdown`に含めない**。無料枠(1TB/月)がアカウント単位・
  月単位でしか判定できず、ジョブ単位には原理的に配分できないため。ジョブ側は
  「このジョブが生む配信量(`deliveryBytes`)」だけを返し、月次の超過分の課金は
  集計API側（`estimateCloudFrontCost()`）が算出する。

- **円換算は固定レートの定数**（`USD_TO_JPY_RATE` / `USD_TO_JPY_RATE_AS_OF` /
  `usdToJpy()`）。管理画面の通貨切り替え用で、計算・集計・API応答はすべてUSDのまま行い
  **表示の直前でだけ換算する**（円建ての値を持ち回るとレート変更で過去の集計値の意味が
  変わってしまうため）。実際の請求はAWSが月ごとに適用するレート（＋カード会社の手数料）
  で確定するので固定レートの時点で数%はずれるが、コスト推定自体が桁を掴むための概算で
  ある以上、日次でレートを取りに行く仕組みを足す価値は無いという判断。ズレが気になったら
  この定数を書き換える。

**これは請求額ではなく推定値**である。用途は「どのジョブが異常に高いか」「月次で
いくら使っているか」の運用把握であり、会計用途ではない。

## 運用設定（`src/settings.ts`、Issue #14）

`GET`/`POST /admin/settings`の契約。ジョブレコードとは別の、DynamoDBの
`SettingsTable`にシングルトンで持つ運用設定（`AdminSettings`）を表す。

- `acceptingNewJobs`: **キルスイッチ**。falseで`POST /magic-links`（新規録画受付）を
  即座に停止する。月間コストガードが発動する前に運用者が手動で全面停止できるように
  するための機能。
- `monthlyCostLimitUsd`: **月間コストガード**の閾値（USD、既定
  `DEFAULT_MONTHLY_COST_LIMIT_USD` = 50）。月間の録画**回数**ではなく、上記
  「コスト推定」による**当月の推定コスト合計**がこの金額に達したら新規受付を止める。
  自宅サーバーを追加録画ワーカーとして導入する構想（Issue #49）が実現すると
  ジョブ単価が一様でなくなる見込みのため、回数ではなく金額で判定する設計にしている。
- `AdminSettingsResponse`は`AdminSettings`に加えて`currentMonthCostUsd`
  （当月の推定コスト合計。CloudFrontの無料枠超過分を含む）と`costLimitReached`
  （`currentMonthCostUsd >= monthlyCostLimitUsd`）を含む。

API側の実装詳細（キャッシュ戦略・反映タイミングの非対称性等）は
`apps/api/README.md`「キルスイッチ・月間コストガード」と
[`docs/decisions/0022`](../../docs/decisions/0022-cost-guard-by-estimated-amount-not-job-count.md)、
フロント側は[`apps/web/docs/admin-ui.md`](../../apps/web/docs/admin-ui.md) §9を参照。

## ダウンロードファイル名・Content-Disposition（`src/download.ts`）

`buildDownloadFilename()` がリプレイ内容（タイトル・難易度・キャラ・スコア・
プレイヤー名）から `"東方地霊殿 Lunatic 霊夢A 442,469,780 (プレイヤー koyi)
#TouhouSattori.mp4"` のようなファイル名を組み立て、`buildContentDispositionValue()`
が RFC 5987 準拠の `Content-Disposition` ヘッダー値（`filename*=UTF-8''...` +
ASCIIフォールバックの `filename=...` 併記）に変換する。実際にこの値をCloudFront経由の
ダウンロードURLへ渡す仕組みは `apps/api/README.md` を参照。
