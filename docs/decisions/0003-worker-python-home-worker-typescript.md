# 0003. 録画ワーカーだけ Python にし、自宅ワーカーの常駐デーモンは TypeScript にする

- **状態**: 有効
- **決定日**: 2026-07（`home-worker` の TypeScript 移植時に明文化）
- **対象**: worker / home-worker
- **関連**: Issue #49

モノレポは TypeScript に統一しているが、**録画パイプライン（`worker/`）だけ Python** で
書いてある。**この例外は録画パイプラインに限る** —— 自宅ワーカーの常駐デーモン
（`home-worker/`）は同じ「自宅で動くコード」でもコントロールプレーンしか担わないため
TypeScript である。新しいコードを足すときに「worker 系だから Python」と判断しないこと。

## 背景

PoC（touhou-recorder）は全体が Python で書かれており、そこで実証済みだったのは
**録画パイプラインの部分**である。本リポジトリはウェブサービスとして TypeScript の
モノレポで作られているため、どこまでを Python のまま持ち込むかの線引きが必要だった。

## 決定

- **`worker/`（録画パイプライン）は Python**。PoC のコードをほぼそのまま移植した。
- **`home-worker/`（自宅サーバーの常駐デーモン）は TypeScript**。pnpm workspace の
  `@sattori/home-worker` として他パッケージと同じビルド・テストに載せている。

## 根拠

線引きの基準は「**Python を採る根拠がその範囲に当てはまるか**」である。

Python を採る根拠は、numpy / PIL によるフレーム差分（処理落ち検知・画面静止による
終了検知・重複フレーム率の測定）と Wine 制御が PoC で実証済みであること。これらは
録画パイプラインの中にしかない。

`home-worker/` がやるのは DynamoDB の条件付き更新・`docker run`・CloudWatch Logs への
転送だけで、**録画パイプラインのロジックは一切持たない**（録画そのものは EC2 と
まったく同じ ECR イメージが行う）。上記の根拠が一つも当てはまらない。

一方 TypeScript にすることで、AWS 側と噛み合う型・定数（`SUPPORTED_GAME_IDS` /
`WorkerHeartbeat` / `WORKER_HEARTBEAT_*` / `HOME_WORKER_OFFER_INDEX` など）を
`@sattori/shared` から**直接 import できる**。Python にすると同じ定義を手書きで
二重管理することになり、AWS 側と自宅側で食い違ったときに黙って claim が壊れる。

## 採らなかった選択肢

- **すべて TypeScript に統一し、録画パイプラインも書き直す**。numpy / PIL 相当の
  フレーム差分処理と Wine 制御を再実装・再検証するコストが大きく、
  「インスタンスタイプ・録画パイプラインの変更は必ず実機検証を経ること」
  （`AGENTS.md` §3）という方針とも噛み合わない。
- **`home-worker/` も Python にして worker 側と言語を揃える**。「自宅で動くもの」という
  設置場所での括りには意味がなく、共有型の二重管理だけが残る。実際、TypeScript 移植前は
  Python 実装（`runner.py`）だった。

## 影響範囲

- `worker/`（Python。`worker/README.md`）
- `home-worker/`（TypeScript。`home-worker/README.md`）
- `packages/shared`（`home-worker` が型・定数を import する前提になっている）
- `AGENTS.md` §3
