# 0034. Launch/HandleFailureの判定タイミングは早期失敗通知の遅延と書き込み競合を考慮して決める

- **状態**: 有効
- **決定日**: 2026-08-26
- **対象**: apps/api
- **関連**: Issue #11（PR #21）、Issue #49（PR #92）

`sfn/handleFailure.ts`は失敗検知から3分待ってから判定する。自宅ワーカーへ割り当てた
ジョブの`launching`更新は、`Launch`ハンドラ自身ではなくデーモンのclaim更新に含める。
どちらも「タイミングを間違えると別の状態を上書きする」事故を避けるための判断である。

## 背景

Step Functionsの`Launch`（`waitForTaskToken`）→失敗時`WaitBeforeCheck`→
`HandleFailure`という流れ（PR #21、Issue #11）は、ワーカー自身がtaskToken経由で
成否を通知する設計を前提にしている。この前提の上で、2箇所のタイミングを詰める
必要が生じた。

## 決定

- **`WaitBeforeCheck`を3分に設定する**（`sfn/handleFailure.ts`が呼ばれる前）。
  Spot中断・Instance Rebalance Recommendationの早期失敗通知は、ワーカーがまだ
  後片付け中の間に送られてくる。通知を受け取った瞬間に孤児判定・terminateへ
  進むと、ワーカーが送るはずだった`SendTaskFailure`と競合したり、後片付け中の
  リソースを巻き込んだりしうるため、猶予を置いてから判定する。
- **自宅ワーカーへの割り当てでは、`launching`への更新を`Launch`ハンドラではなく
  デーモンのclaim（条件付き更新）の中で行う**（`apps/api/src/homeWorker.ts`、
  Issue #49・PR #92）。`Launch`ハンドラが別タイミングで`launching`を書くと、
  デーモンが既にコンテナを起動して`recording`へ進めていた場合にその状態を
  上書きしてしまう恐れがある。claimと同じ原子的な更新に含めることで、
  「claimが成立した瞬間の状態」だけが正になる。

## 根拠

- 3分という値は、ワーカー側のSpot中断ハンドリング（IMDS経由で2分前通知を検知し
  即座に`SendTaskFailure`を試みる）に対して十分な猶予を確保しつつ、孤児化した
  インスタンスの課金期間を必要以上に延ばさない値として選んでいる。
- `launching`の書き込み元を1箇所（claim更新）に絞ることで、`Launch`ハンドラと
  デーモンの2箇所が非同期にジョブレコードを更新する場合に生じるレースを
  構造的に排除できる。

## 採らなかった選択肢

- **早期失敗通知を受けた瞬間に`HandleFailure`を呼ぶ**。ワーカー側の後片付け・
  `SendTaskFailure`呼び出しと競合する余地が残る。
- **`Launch`ハンドラがオファー送出と同時に`launching`を書く**。デーモンのclaim・
  コンテナ起動のタイミング次第で、先に進んだ`recording`状態を後から上書きする
  レースが生じる。

## 影響範囲

- `apps/api/src/handlers/sfn/handleFailure.ts`・`infra/lib/sattori-stack.ts`
  （`WaitBeforeCheck`のステート定義）
- `apps/api/src/homeWorker.ts`（claim時の`launching`更新）
- `apps/api/README.md` §2「ジョブ起動〜Step Functionsの流れ」
