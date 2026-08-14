# 0010. 低速録画をワーカー側の分岐にせず、起動側が渡す環境変数だけで表す

- **状態**: 有効
- **決定日**: 2026-08
- **対象**: worker / apps/api / home-worker / packages/shared
- **関連**: Issue #68、Issue #49、touhou-recorder reports/45・46・47・48、
  `docs/reports/2026-08-11-th20-slow-motion-local.md`

低速録画（1/2倍速で録画し後処理で等倍へ戻す）は自宅ワーカー限定・対応タイトル限定だが、
**ワーカーの中に「自宅かEC2か」「対応タイトルか」の分岐を作らない**。有効・無効は起動側が
`FPS_LIMIT_TARGET_HZ` を渡すかどうかだけで決まる。ワーカー側に条件分岐を足したくなったら、
まずここを読むこと。

## 背景

th20 は Xvfb + wined3d + llvmpipe のソフトウェアレンダリングに対して描画負荷が重く、
ボム・スペルカード等の高負荷区間で**ゲームエンジン自体が処理落ちする**（ローカル実機で
最低 19.8fps、`c7i.2xlarge` で最低 9.1fps、reports/45・46）。録画側のコマ落ちではなく
ゲーム進行そのものが遅くなるため、等倍録画のままでは品質を担保できない。

対策の 1/2 倍速録画は録画に倍の実時間がかかる。**EC2 では録画時間＝Spot 料金なので割に
合わず**、自宅ワーカー限定の手段になる。一方で「録画そのものは EC2 と自宅で同じ ECR
イメージ・同じ taskToken 契約で動く」という全体方針（`AGENTS.md` §3、Issue #49）がある。

## 決定

- **ワーカーは自分が EC2 にいるのか自宅にいるのかを知らない**。低速録画は環境変数
  **`FPS_LIMIT_TARGET_HZ` の有無だけ**で決まり、未設定なら全タイトル従来どおり等倍で動く。
- どのジョブに付けるかは**起動側**が決める（`apps/api/src/workerEnv.ts` /
  `workerRouting.ts`、`packages/shared/src/slowMotion.ts` の
  `SLOW_MOTION_SUPPORTED_GAME_IDS`）。
- 自宅ワーカーの常駐デーモンも録画速度を知らない。オファーに添えられた `homeWorkerEnv` を
  そのまま `docker run -e` へ渡すだけ（`home-worker/README.md` §7）。
- **claim されなければ EC2 での等倍録画へ静かにフォールバックする**。

## 根拠

- ワーカー側で分岐すると、**同じイメージが実行環境によって別の挙動をする**ことになり、
  EC2 と自宅で同じイメージを使う前提（Issue #49）が崩れる。ローカルでの再現も、
  「どちらのつもりで動いているか」を再現しないとできなくなる。
- 対応タイトルの判定（`SLOW_MOTION_SUPPORTED_GAME_IDS`）を起動側に置けば、フロントエンドの
  オプション表示・オファーのルーティング・実際に渡す環境変数が**すべて同じ1つの定義**
  （`packages/shared`）を見る。ワーカー側にもう一つ持つと二重管理になる。
- フォールバックが「環境変数を付けない」だけで済む。ワーカー側に分岐があると、
  フォールバック経路にも対応する分岐が要る。

## 採らなかった選択肢

- **ワーカーが `WORKER_KIND` を見て自分で低速録画を選ぶ**。上記のとおりイメージの
  同一性が崩れる。
- **自宅ワーカー用に別イメージを作る**。ECR イメージ・ビルド・push の対象が2倍になり、
  片方だけ古いという事故が起きる。
- **低速録画を EC2 でも使う**。録画時間が倍になり Spot 料金も倍になるため割に合わない。
  代わりに EC2 では 4xlarge 級で等倍録画する（`home-worker/README.md` §7）。

## 影響範囲

- `packages/shared/src/slowMotion.ts`（`SLOW_MOTION_SUPPORTED_GAME_IDS`・`slowMotionScale`）
- `apps/api/src/workerEnv.ts` / `workerRouting.ts`（誰に何を渡すか）
- `worker/`（`FPS_LIMIT_TARGET_HZ` の有無だけを見る。`worker/README.md`「低速録画」）
- `apps/web`（低速録画オプションの表示・進捗バジェットへの織り込み）
- **未対応タイトルで低速録画を要求すると2倍速の動画ができ、ワーカーはそれを検知できない**
  （`docs/known-limitations.md` §1）。分岐をワーカーに置かない代償であり、
  起動側の判定が唯一の防波堤になっている。
- `AGENTS.md` §3
