# 0021. コスト推定用の付随データは、取得に失敗してもジョブを落とさず、後から上書きしない

- **状態**: 有効
- **決定日**: 2026-08
- **対象**: apps/api
- **関連**: Issue #60

`Launch`（`apps/api/src/handlers/sfn/launch.ts`）はコスト推定（Issue #60）のために
Spot 単価（`spotPricePerHour`）と課金起点（`launchedAt`）をジョブレコードへ記録する。
**単価の取得に失敗しても例外を投げずに握りつぶす**、**`launchedAt` は既に値があれば
書き換えない**。どちらも「監視のための付随情報が、監視対象そのものを壊さない」ための
決定である。

## 背景

`CreateFleet` のレスポンスからは確保できたインスタンスタイプと AZ が取れるが、
**Spot 単価だけは含まれない**ため、`fetchSpotPrice()` が
`DescribeSpotPriceHistory` を1回だけ引いて記録している。

また `Launch` は Step Functions のリトライで最大10回走る
（`apps/api/src/retryPolicy.ts`）。素直に書くと `launchedAt` は毎回上書きされる。

## 決定

- **`fetchSpotPrice()` の失敗は握りつぶして `null` を返す**。コスト推定側は
  フォールバック単価（`packages/shared/src/cost.ts`）へ縮退し、その旨は
  レスポンスの `quality` として管理画面に出る。
- **`markJobLaunched()` は `launchedAt` に既に値があれば書き換えない**条件付き更新にする。

## 根拠

- 単価は運用把握のための付随情報にすぎない。これを理由に起動を失敗させると、
  **リトライ枠（最大10回）を無駄に消費してユーザーの録画そのものを落とす**。
- `launchedAt` を毎回上書きすると、それ以前の試行で稼働していた EC2 の課金時間が推定から
  丸ごと抜け落ちる。**失敗を繰り返した高コストなジョブほど安く見える**という、監視と
  しては最悪の挙動になる。
- そもそも管理画面のコスト表示は推定値であって請求額ではない（`AGENTS.md` §3）。
  精度のために可用性を落とすトレードオフは成立しない。

## 採らなかった選択肢

- **単価取得を必須にしてリトライする**。上記のとおりユーザーの録画を落としうる。
- **`launchedAt` を試行ごとの配列にする**。ジョブレコードの形が複雑になり、
  全件 Scan で集計している現在の実装（Issue #60）に対して割に合わない。
- **課金起点を `createdAt` にする**。`createdAt` はマジックリンク送信要求の時点なので、
  日付をまたいで起動されたジョブでは日次バケットが1日ずれる
  （[`apps/api/docs/admin-api.md`](../../apps/api/docs/admin-api.md) §9）。

## 影響範囲

- `apps/api/src/ec2.ts`（`fetchSpotPrice()`）
- `apps/api/src/handlers/sfn/launch.ts` / `src/jobs.ts`（`markJobLaunched()`）
- `apps/api/src/adminCosts.ts`・`packages/shared/src/cost.ts`（フォールバック単価と
  `quality` の扱い）
- `apps/web/src/admin/`（推定値であることの表示。
  [`apps/web/docs/admin-ui.md`](../../apps/web/docs/admin-ui.md)）
