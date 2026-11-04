# 0062. GPUフォールバック先（eu-north-1）に出力バケットとタイトル資産のレプリカを置く

- **状態**: 有効
- **決定日**: 2026-10-11
- **対象**: apps/api / infra / packages/shared / worker
- **関連**: Issue #313、#296、[`0061`](0061-gpu-capacity-fallback-to-eu-north-1.md)、[`docs/reports/2026-10-11-gpu-fallback-eu-north-1-production-e2e.md`](../reports/2026-10-11-gpu-fallback-eu-north-1-production-e2e.md)

eu-north-1で動くGPUワーカーは、eu-north-1の出力バケットへ書き、eu-north-1のタイトル資産
レプリカから読む。どこへ書いたかは`JobRecord.outputRegion`に記録する。配信はMediaCdnの
`/eu-north-1/*`から行う。0061の「データ面は一切移さない」と、採らなかった選択肢
「タイトル資産・出力バケットをeu-north-1へ複製する」を置き換える。DynamoDB・Step Functions・
ログ・リプレイは一次リージョンのまま。

## 背景

0061のフォールバックを本番で動かすと、リージョン間転送料（$0.02/GB）がSpot代の2〜5倍になった
（`docs/reports/2026-10-11-gpu-fallback-eu-north-1-production-e2e.md`）。eu-south-2のGPU在庫は
長期的に枯渇しているため、逃がすジョブは例外ではなく常態になっている。

eu-north-1で動いた6ジョブを集計した（2026-10-11、DynamoDB）:

| 内訳 | 転送量 | 割合 |
| --- | --- | --- |
| タイトル資産のダウンロード | 5.85 GiB | 約47%（th06ncは1件1.27GiB） |
| チェックポイント＋出力のアップロード | 6.52 GiB | 約53% |

直近30日のGPUジョブは127件。全件が逃げた場合、転送料は月$4前後になる。

## 決定

- **出力**: 起動側（`apps/api/src/workerEnv.ts`）が、起動先リージョンの出力バケットを`OUTPUT_BUCKET`/
  `OUTPUT_BUCKET_REGION`として渡す（`config.ts`の`dataBucketsFor()`）。S3のキー構成は変えない。
- **`outputRegion`**: ワーカー（`worker/status.py`）は、パスを書くUpdateItemと同じ更新で
  `outputRegion`も書く。対象はoutputPath・outputPath720p・posterImagePath・previewImagePath。
  パスとリージョンが食い違う瞬間は無い。属性が無ければ一次リージョン扱い。
- **配信**: MediaCdnに`eu-north-1/*`のbehaviorを足し、eu-north-1の出力バケットをオリジンにする。
  CloudFront Function（viewer-request）でプレフィックスを外す。プレフィックスを付けるのはAPIだけ
  （`apps/api/src/downloads.ts`の`cdnPathFor()`）。OACの許可は、フォールバック先スタックの
  バケットポリシーで付ける。対象はこのアカウントのdistribution（`distribution/*`）。
- **タイトル資産**: 本体のTitleAssetsBucketから、S3レプリケーション（`titles/`、削除マーカーも
  複製）でレプリカへ自動複製する。起動側は`TITLE_ASSETS_BUCKET`/`TITLE_ASSETS_BUCKET_REGION`を
  渡し、ワーカーは`titleAssetsRegion`を記録する。
- **リトライでリージョンが変わる場合**: 起動側が`job.outputRegion`から`CHECKPOINT_BUCKET`/
  `CHECKPOINT_BUCKET_REGION`を決める。ワーカーはそこからチェックポイントを読み、最終出力は
  自分のリージョンへ書く。チェックポイントは元のバケットから消す。リージョンを固定しない
  方針（0061）は変えない。
- **ワーカーにリージョンの分岐を作らない**。違いはすべて環境変数で表す。ワーカーは渡された
  リージョンでS3クライアントを作るだけ（`entrypoint.py`の`s3_client()`）。
- **2スタック間に参照を張らない**方針（0061）も維持する。バケット名は固定名で、
  `infra/lib/gpu-fallback.ts`の`gpuFallbackOutputBucketName()`・`gpuFallbackTitleAssetsBucketName()`。
- **コスト推定**（`cost.ts`）: タイトル資産と出力を、それぞれ`titleAssetsRegion`・`outputRegion`が
  `workerRegion`と違うときだけ計上する。

## 根拠

- 0061で「最良でも年$30程度で見合わない」とした根拠は、**価格で振り分ける**案の収支だった。
  容量不足で逃がすジョブが常態化した今は、逃がしたジョブの転送料そのもの（1件$0.02〜0.08）が
  対象になる。
- 固定費は小さい。レプリカの保管料は約8GiBで月$0.2、資産を差し替えたときの複製転送は$0.02/GB。
  S3→CloudFrontのオリジン取得は無料なので、配信の費用は変わらない。
- 0061で懸念した「CloudFrontの2オリジン化・`JobRecord`への出力リージョン保持・複製の運用」は、
  次のように吸収した:
  - 2オリジン化は、パスのプレフィックスとFunction 1つで済む。
  - 出力リージョンは、パスと同じ更新で書く1属性で済む。
  - 複製はS3レプリケーションで自動化した。
- タイトル資産も対象にしたのは、転送量の約半分を占め、出力だけ移しても半分しか減らないため。
  th06ncの等倍録画なら約3割しか減らない。

## 採らなかった選択肢

- **出力だけ移す**。上記のとおり、転送料は半分しか減らない。
- **CloudFrontのオリジングループ**（一次バケットが403/404ならeu-north-1へフェイルオーバー）。
  URLを変えずに済む。ただし、どのバケットにあるかが暗黙になり、管理画面の署名付きURLや
  チェックポイントの在りかは結局リージョンを知る必要がある。また、eu-north-1の配信は毎回
  一次バケットへの空振りを挟む。
- **eu-north-1のバケットのキーにプレフィックスを付ける**（Functionを使わない）。ワーカーの
  キー定数・ライフサイクルルールのプレフィックスまでリージョンごとに変わる。
- **2つ目のCloudFront distributionを作る**。無料枠はアカウント単位なので得が無く、API側で
  ドメインを出し分ける必要がある。
- **OACの許可をdistribution IDで絞る**（`cdk.json`のコンテキストで渡す）。デプロイ順の都合で、
  初回デプロイ時にIDが決まっていない環境を作れない。同じアカウントのdistribution全体に許すことで
  広がる範囲は、このアカウントの管理者が作るdistributionだけ。

## 影響範囲

- MediaCdnの配信パスを組み立てるときは、必ず`cdnPathFor()`（`buildCdnUrl`・`buildVideoDownloadUrl`）を
  通し、`outputRegion`を渡すこと。直接`https://<cdn>/<path>`を組み立てると、フォールバック先の
  出力が404になる。
- ワーカーが出力バケットへ新しいパスを書き、それをAPIが返すようにするなら、その更新でも
  `outputRegion`を書くこと（`status.py`）。
- フォールバック先を別のリージョンへ変える・増やすときは、CloudFrontのbehavior・Function・
  バケット名・`mediaCdnOf()`の`secondaryRegions`をそろえて変えること。
- タイトル資産を差し替えたら、レプリカへの複製の完了を確かめる（`upload-title-assets` skill）。
  複製が終わるまでの数分間、フォールバック先は旧資産を読みうる（`docs/known-limitations.md`）。
- 既存の資産は複製されない（S3レプリケーションは新しく書かれたオブジェクトだけを複製する）。
  初回デプロイで一括コピーする（`deploy-sattori` skill）。
