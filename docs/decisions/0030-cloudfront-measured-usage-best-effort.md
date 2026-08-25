# 0030. CloudFrontの実配信量はCloudWatchから取得する付随データとし、失敗しても集計APIを壊さない

- **状態**: 有効
- **決定日**: 2026-08-25
- **対象**: apps/api / packages/shared / infra
- **関連**: Issue #163

管理画面のコスト集計（`GET /admin/costs`）にCloudFrontの**実配信量**（CloudWatch
`AWS/CloudFront`名前空間の`BytesDownloaded`）を追加する。ジョブ単位推定の月次積み上げ
（`deliveryBytes`）とは独立した参考値として併記するだけで、無料枠判定・超過額の計算には
使わない。取得は月間コストガード（`costGuard.ts`）の判定経路には組み込まない。

## 背景

既存の`deliveryBytes`は「720p版が1回ダウンロードされる」という前提のジョブ単位推定の
積み上げで、再ダウンロード・レンジリクエスト・失敗ダウンロードの再試行は反映されない
（Issue #163本文）。実際の消費量とどれだけ乖離しているかを把握したいという運用要望から、
CloudWatchメトリクス（無料・ほぼリアルタイム）を追加で取得することにした。Cost Explorer API
（`ce:GetCostAndUsage`、日次粒度・最大24時間遅延・呼び出し課金あり）はIssue本文で
「必要になれば追加で検討する」とされており、今回は見送る。

## 決定

- **CloudWatchのメトリクスは常に`us-east-1`にしか存在しない**（CloudFrontはグローバル
  サービスのため）。Lambda実行リージョン（eu-south-2）とは別に`region: "us-east-1"`を
  明示したクライアントを`apps/api/src/cloudfrontMetrics.ts`で生成する
  （`apps/api/src/ses.ts`の`sesClient()`と同じ理由・同じ遅延生成パターン）。
- **1日粒度のSumをアプリ側で月ごとに合算する**。CloudWatchの`Period`は60の倍数秒で
  指定する必要があり、暦月は日数が一定しないため月単位を直接指定できない。
  `adminCosts.ts`が`JobsTable`の全件Scan結果を月ごとに合算しているのと同じ考え方。
- **`cloudFrontDistributionId`を渡さない呼び出しではCloudWatchを一切呼ばない**
  （`summarizeCosts()`のオプション引数）。`estimateCurrentMonthCostUsd()`
  （月間コストガードの入力）はこの引数を渡さない——新規受付を止めるかどうかの
  判定経路に外部APIへの依存を増やさないため。
- **取得に失敗しても例外を投げず、空のMapを返す**
  （`fetchMeasuredCloudFrontBytesByMonth()`が`try/catch`で握りつぶす）。呼び出し元は
  該当月の`measuredDeliveryBytes`を`null`として扱う。`GET /admin/costs`自体は200を返し
  続け、既存の推定値表示は壊れない。

## 根拠

- 実測値は「推定値とどれだけ乖離しているか」を確認するための付随情報であり、集計API
  本体の可用性を落としてまで取得すべきものではない
  （[`docs/decisions/0021`](0021-cost-estimation-side-data-never-fails-the-job.md)と
  同じ考え方——あちらはSpot単価・起動時刻の記録失敗、こちらはCloudWatch読み取り失敗が
  対象という違いだけで、方針は同一）。
- CloudWatchの権限（`cloudwatch:GetMetricData`）はデプロイ直後や新しいdistributionでは
  データが無い、あるいはIAMロールの更新漏れで一時的に失敗しうる。これで管理画面の
  コストページ全体が真っ白になるのは本末転倒。
- 月間コストガードは「新規受付を止めるか」を決める、ユーザー向け経路に直結する判定
  （`docs/decisions/0022`）。ここに新しい外部API呼び出し（CloudWatch）を足すと、
  CloudWatch側の障害が録画受付停止の判定にまで波及しうる。実測値はガードの入力に
  使う必要が無い（推定値の合計で十分、Issue #163の提案通り）ため、そもそも呼ばない
  構成にして依存自体を断つ。

## 採らなかった選択肢

- **月ごとに`GetMetricData`を個別に呼ぶ（`Period`を暦月の秒数に設定）**。
  `GetMetricData`の`StartTime`/`EndTime`はリクエスト全体で1つしか指定できず、
  クエリごとに異なる期間を持てないため、月の数だけAPI呼び出しが必要になり
  非効率（1日粒度で1回取得してアプリ側で合算する方が呼び出し回数が少ない）。
- **Cost Explorer API（`ce:GetCostAndUsage`）を今回あわせて実装する**。Issue本文の
  提案通り「まずはCloudWatchだけ」に絞った。Cost Explorerは日次粒度・最大24時間遅延・
  呼び出し課金($0.01/リクエスト)があり、用途（月末の無料枠消費の正確な締め）が
  ダッシュボードのほぼリアルタイム表示とは異なるため、必要になった時点で別途検討する。
- **実測値を月間コストガードの判定にも使う**。実測値の方が正確だが、CloudWatchの
  可用性がユーザー向け機能（新規受付）に波及するリスクと釣り合わない。ガードは
  引き続き推定値（`estimateJobCost`の積み上げ）だけで判定する。

## 影響範囲

- `apps/api/src/cloudfrontMetrics.ts`（新規、`fetchMeasuredCloudFrontBytesByMonth()`）
- `apps/api/src/adminCosts.ts`（`summarizeCosts()`の`cloudFrontDistributionId`オプション）
- `apps/api/src/handlers/admin/getCosts.ts`（`CLOUDFRONT_DISTRIBUTION_ID`環境変数を
  `required()`で読み、`summarizeCosts()`へ渡す）
- `packages/shared/src/admin.ts`（`AdminCloudFrontMonth.measuredDeliveryBytes`）
- `apps/web/src/admin/CostsPage.tsx`（実測列の表示）
- `infra/lib/sattori-stack.ts`（`AdminGetCostsFn`への`CLOUDFRONT_DISTRIBUTION_ID`環境変数と
  `cloudwatch:GetMetricData`権限）
