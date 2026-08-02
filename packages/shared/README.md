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
  ない)とプレビュー画像URL(`previewImageUrl`)も返す |

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
  （生動画チェックポイントアップロード済み）〜720p変換〜出力アップロード完了までを指す。
- `isTerminalStatus()` が `done`/`failed` を終端状態として判定する（フロントエンドの
  ポーリング停止判定に使用）。

`JobRecord`（DynamoDB `JobsTable` の1アイテムに対応する型）は状態そのものに加え、
`instanceId`/`instanceType`/`availabilityZone`（実際に確保されたEC2インスタンスの
運用調査用データ、ユーザー向けAPIには含めない）、`replayInfo`（解析済みリプレイ内容の
転記、ページBでの表示用）、`retriedToJobId`/`retriedFromJobId`（管理画面からの
再実行で複製された元ジョブ⇄新ジョブの相互リンク、Issue #59）、
`launchedAt`/`spotPricePerHour`/`outputBytes`/`outputBytes720p`（コスト推定の入力、
Issue #60。後述「コスト推定」）等を持つ。
フィールドごとの詳細はソースのコメントを参照。

> **`JobRecord`にフィールドを足すときの注意**: `apps/api`の`requestMagicLink.ts`
> （新規作成）と`admin/retryJob.ts`の`buildRetryJob()`（再実行時の複製）の両方が
> 全フィールドを明示的に埋めるため、型エラーとして必ず気付ける。ただし
> `buildRetryJob()`は元ジョブをスプレッドで引き継ぐので、**実行結果に属する
> フィールド（出力・インスタンス情報・時刻）は明示的にnullへ初期化すること**
> （引き継ぐと新ジョブが元ジョブの結果を持ったまま起動する）。

## リプレイ情報（`src/replay.ts`, `src/games.ts`）

- `ReplayInfo`: `packages/replay-parser` の `ParsedReplay`（ステージ内訳など
  Sattori では使わない情報も含むリッチな型）から、ページA表示・録画メタデータに
  必要な項目だけを抜き出したサブセット。`fromParsedReplay()` が変換を行う。
  replay-parser は単体でOSS公開できるよう Sattori 固有の型に依存しない設計になっているため、
  この変換ロジックは replay-parser 側ではなく shared 側に置く（依存の向きは
  shared → replay-parser の一方向）。
- `parseReplayInfo()`: バイト列から `ReplayInfo` を得るエントリポイント。フォーマット
  解析エラーに加え、`SUPPORTED_GAME_IDS`（`games.ts`。現状 th06/07/08/11）に含まれない
  タイトルも `unsupported_game` エラーとして日本語メッセージ付きで返す。
- `GAME_IDS`/`GAME_TITLES`（`games.ts`）: th06〜th20（th19除く）の識別子と表示用の
  日本語タイトル名。録画対応タイトルは `SUPPORTED_GAME_IDS` で別途絞り込む
  （パーサー対応と録画対応は別軸。詳細は `packages/replay-parser/README.md`）。

## 管理API契約（`src/admin.ts`、Issue #51）

`src/api.ts`とは意図的に別ファイルに分離している。`api.ts`は「ユーザー向け」契約で、
`GetJobResponse`が`email`/`instanceId`等の内部データを意図的に除外しているのに対し、
`admin.ts`は正反対の方針（`AdminJobDetailResponse.job`は`JobRecord`をほぼそのまま返す）
を取るため。管理APIは`/admin/*`のLambda Authorizer（共有トークン）配下にしか
存在しないため、内部データを含めても問題ない前提に立っている。

| メソッド・パス | 用途 |
| --- | --- |
| `GET /admin/jobs` | ジョブ一覧（新しい順、`status`絞り込み、カーソルページング） |
| `GET /admin/jobs/{jobId}` | ジョブ詳細（`JobRecord`全フィールド＋ダウンロード導線） |
| `GET /admin/jobs/{jobId}/execution` | Step Functions実行の状態・履歴 |
| `GET /admin/jobs/{jobId}/logs` | ワーカーコンテナのCloudWatch Logs（Issue #58） |
| `POST /admin/jobs/{jobId}/stop` | ジョブの緊急停止（Issue #59） |
| `POST /admin/jobs/{jobId}/retry` | ジョブの再実行（Issue #59。**新しいjobIdのジョブとして複製・起動**するため、レスポンスの`jobId`はパスのそれとは別物） |
| `GET /admin/costs` | コスト推定の日次/週次/月次集計（Issue #60。後述「コスト推定」） |

参照系と違い停止・再実行は状態を変えるため`POST`（`DELETE`にすると
`corsPreflight.allowMethods`の拡張も要る）。再実行の複製元/複製先は
`JobRecord.retriedFromJobId`/`.retriedToJobId`で相互に辿れる。

API側の実装詳細（GSI設計・authorizer・ダウンロードURLの発行方法等）は
`apps/api/README.md`「管理API」、フロント側は`apps/web/README.md`「管理画面」を参照。

## コスト推定（`src/cost.ts`、Issue #60）

管理画面がジョブ単位・期間単位のコストを表示するための**推定ロジックと単価定数**。
ジョブ詳細のコストパネル（フロント）と集計API（Lambda）の両方がこの1本を共有する
（画面ごとに再実装して数字が食い違う事故を避けるため）。

- `estimateJobCost(job, now)`: 1ジョブぶんの内訳（`ec2Spot` / `ebs` / `publicIpv4` /
  `s3Storage` / `misc`）と合計を返す純関数。`now`を引数に取るのは、実行中ジョブの
  推定値をテストで固定できるようにするため。
- 単価は**us-east-1・2026-07-27時点**（`docs/aws-region-cost-analysis.md`）。
  リージョンを移す場合はここの定数も入れ替える。
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

**これは請求額ではなく推定値**である。用途は「どのジョブが異常に高いか」「月次で
いくら使っているか」の運用把握であり、会計用途ではない。

## ダウンロードファイル名・Content-Disposition（`src/download.ts`）

`buildDownloadFilename()` がリプレイ内容（タイトル・難易度・キャラ・スコア・
プレイヤー名）から `"東方地霊殿 Lunatic 霊夢A 442,469,780 (プレイヤー koyi)
#TouhouSattori.mp4"` のようなファイル名を組み立て、`buildContentDispositionValue()`
が RFC 5987 準拠の `Content-Disposition` ヘッダー値（`filename*=UTF-8''...` +
ASCIIフォールバックの `filename=...` 併記）に変換する。実際にこの値をCloudFront経由の
ダウンロードURLへ渡す仕組みは `apps/api/README.md` を参照。
