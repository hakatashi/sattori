# 0006. 進捗表示は単純なポーリングにし、WebSocket / SSE を使わない

- **状態**: 有効
- **決定日**: 2026-06
- **対象**: apps/web / apps/api / infra

録画の進捗はフロントエンドが `GET /jobs/{jobId}` を3秒間隔で叩いて取る。
**月間最大1000回という規模に対して WebSocket / SSE は過剰**という判断。
「リアルタイム性が足りない」ように見えても、押し出す方式へ変える前にこの判断を読むこと。

## 背景

録画は数十分かかる長時間ジョブで、その間ユーザーはページBで進捗を見続ける。
進捗の更新源は DynamoDB のジョブレコード（ワーカーが更新する）である。

## 決定

- **`hooks/useJobPolling.ts` が `getJob()` を3秒間隔（`POLL_INTERVAL_MS`）で呼び、
  `isTerminalStatus()`（`done` / `failed`）に達したら止める**。
- 取得エラー時もポーリングは止めず再試行する（連続失敗を想定）。
- ポーリングの隙間は `hooks/useEstimatedProgress.ts` が実時間で補間して滑らかに見せる
  （Issue #108）。

## 根拠

- **想定利用規模が月間最大1000回**。1ジョブあたり数十分 × 3秒間隔でも、API Gateway と
  Lambda の呼び出し回数はこの規模では誤差にしかならない。
- WebSocket を使うには API Gateway の WebSocket API（別リソース・別課金・接続 ID の
  管理テーブル）が要り、SSE は Lambda + API Gateway の HTTP API で素直に扱えない。
  **コストとオペレーションの最小化を最優先する**方針（`AGENTS.md` §1）に反する。
- 進捗の粒度は「録画が何秒ぶん進んだか」であり、3秒の遅延が体験を損なう類の情報ではない。

## 採らなかった選択肢

- **API Gateway WebSocket API**。上記のとおり管理対象が増える。
- **SSE（Server-Sent Events）**。Lambda のレスポンスストリーミングを使うことになり、
  API Gateway HTTP API 経由の現構成から外れる。
- **ポーリング間隔をもっと長くする**。3秒は体感の滑らかさとの折り合いで、
  補間（`useEstimatedProgress`）と組み合わせて十分な見え方になっている。

## 影響範囲

- `apps/web/src/hooks/useJobPolling.ts`（間隔・停止条件）
- `apps/web/src/hooks/jobProgressBudget.ts`（残り時間の見積もり。低速録画のジョブは
  録画フェーズが実時間で2倍になるため `slowMotion` を織り込む。
  [0010](0010-slow-motion-no-worker-side-branching.md)）
- `apps/api/src/handlers/getJob.ts`（ポーリングで叩かれる前提の軽量なハンドラ）
- `AGENTS.md` §3
