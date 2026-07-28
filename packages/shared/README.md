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
転記、ページBでの表示用）等を持つ。フィールドごとの詳細はソースのコメントを参照。

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

## ダウンロードファイル名・Content-Disposition（`src/download.ts`）

`buildDownloadFilename()` がリプレイ内容（タイトル・難易度・キャラ・スコア・
プレイヤー名）から `"東方地霊殿 Lunatic 霊夢A 442,469,780 (プレイヤー koyi)
#TouhouSattori.mp4"` のようなファイル名を組み立て、`buildContentDispositionValue()`
が RFC 5987 準拠の `Content-Disposition` ヘッダー値（`filename*=UTF-8''...` +
ASCIIフォールバックの `filename=...` 併記）に変換する。実際にこの値をCloudFront経由の
ダウンロードURLへ渡す仕組みは `apps/api/README.md` を参照。
