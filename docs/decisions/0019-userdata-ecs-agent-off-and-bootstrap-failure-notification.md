# 0019. UserData で ECS エージェントを止め、コンテナ起動前の失敗は UserData 自身が通知する

- **状態**: 有効
- **決定日**: 2026-07
- **対象**: apps/api
- **関連**: Issue #23、touhou-recorder reports/28

録画インスタンスの UserData（`apps/api/src/ec2.ts` の `buildUserData()`）には、
知らないと必ず踏む前提が2つある。**ECS 最適化 AMI の ECS エージェントを停止すること**と、
**コンテナが一度も起動できなかった場合の失敗を UserData 自身が Step Functions へ
通知すること**。どちらも実際に事故を起こしてから入れた対策なので、削らないこと。

## 背景

録画ワーカーは ECS 最適化 AMI（docker が入っている）を素の docker ホストとして使って
いる。ECS クラスタには参加していないが、AMI には ECS エージェントが常駐している。

また、ワーカーの成否確定は**コンテナ内の `entrypoint.py` が taskToken で
`SendTaskSuccess`/`SendTaskFailure` を送る**ことで行われる（`AGENTS.md` §2）。
つまりコンテナが起動する前に失敗すると、誰も taskToken を返さない。

## 決定

- **`systemctl disable --now ecs` で ECS エージェントを停止する**。
- **`trap 'shutdown -h now' EXIT`** で、ECR ログイン・pull・docker 実行のどこで失敗しても
  必ずインスタンスを終了させる（孤児防止、課金停止。
  [`0017`](0017-orphan-sweep-from-aws-instances.md)）。
- **コンテナ起動前段階の失敗は UserData 自身が
  `aws stepfunctions send-task-failure` で即座に通知する**。

## 根拠

- ECS エージェントは常駐して CPU を消費し、高負荷区間で ffmpeg の x11grab キャプチャと
  コンテンションを起こして**重複フレーム率を悪化させる**。八雲藍戦（th07）の実測で
  15-26% → 4.8% に改善した。
- コンテナが一度も起動できないまま（ECR ログイン/pull 失敗等）shutdown すると、
  `entrypoint.py` の taskToken 通知が一切実行されず、**Step Functions が60分
  タイムアウトするまでジョブが「起動中」のまま停滞する**事故が実際に起きた。
  ユーザーから見ると、失敗が確定するまで1時間何も起きない。

## 採らなかった選択肢

- **素の Amazon Linux AMI を使って ECS エージェントを最初から持たせない**。docker と
  必要なドライバの導入を UserData で毎回行うことになり、起動時間が伸びる。停止1行で
  済むうえ、AMI の更新追随も ECS 最適化 AMI のほうが手間が少ない。
- **bootstrap 段階の失敗の検知をハートビートタイムアウト（15分）に任せる**。失敗が
  確定するまでユーザーを待たせるうえ、リトライ1周ぶんの時間が丸ごと無駄になる。
- **コンテナ起動前の失敗も掃除役（`sweepOrphanInstances.ts`）に任せる**。あちらは
  課金の停止が目的で、ジョブの失敗確定（＝ユーザーへの応答）は担わない。

## 影響範囲

- `apps/api/src/ec2.ts` の `buildUserData()`（UserData スクリプト本体）
- `infra/`（Launch Template の AMI 指定。`infra/README.md`）
- `apps/api/README.md`「ワーカー起動スクリプト（UserData）」
- インスタンスタイプ・AMI を変える場合は重複フレーム率の実機検証が要る
  （[`0016`](0016-ec2-fleet-instance-type-diversification.md)、`AGENTS.md` §3）
