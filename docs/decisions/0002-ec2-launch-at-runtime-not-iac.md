# 0002. EC2 の起動だけは IaC ではなく実行時に AWS SDK で行う

- **状態**: 有効
- **決定日**: 2026-06（PoC 期の判断を本リポジトリへ引き継いだもの）
- **対象**: infra / apps/api
- **関連**: touhou-recorder reports/16

IaC は AWS CDK（TypeScript）に統一しているが、**録画ワーカーの EC2 インスタンスだけは
IaC で作らず、実行時に AWS SDK で起動する**。PoC で Terraform が Spot キャパシティ不足時に
無限ハングしたため。新しいインフラを足す際もこの分離を崩さないこと。

## 背景

録画ワーカーはジョブ1件ごとに1台起動して、終わったら落とす使い捨てのリソースである。
IaC の管理対象（宣言した状態へ収束させるもの）とは寿命の性質が根本的に違う。

加えて Spot インスタンスは**要求しても取れないことがある**（`InsufficientInstanceCapacity`）。
IaC ツールはこれを「まだ収束していない」とみなして待ち続けようとする。

## 決定

- **CDK が作るのは、ベースとなる Launch Template だけ**。
- **ジョブごとの UserData は実行時に `CreateLaunchTemplateVersion` で上書きし、
  `CreateFleet` で起動する**（`apps/api/src/ec2.ts` の `buildUserData()`）。
- 起動に失敗した場合のリトライは Step Functions のステートマシン側で扱う
  （`apps/api/src/retryPolicy.ts`、最大10回）。

## 根拠

PoC（touhou-recorder `reports/16`）で `terraform-provider-aws` を使って Spot
インスタンスを起動したところ、**キャパシティ不足時に無限ハングした**。タイムアウトも
エラーも返らないため、上位のオーケストレーションから打ち切ることも、別インスタンス
タイプへフォールバックすることもできない。

SDK 直叩きなら、キャパシティ不足はその場でエラーとして返る。候補インスタンスタイプの
分散（`apps/api/README.md`「EC2 Fleet インスタンスタイプの分散配置」、Issue #29）も、
リトライ時に別タイプを試すことも、呼び出し側の制御下に置ける。

## 採らなかった選択肢

- **Terraform / CDK でインスタンスまで宣言する**。上記のハングのため。加えて、
  ジョブごとに `terraform apply` を回す運用そのものが月1000回規模には重い。
- **Auto Scaling Group / Spot Fleet を常設して CDK 管理下に置く**。1ジョブ=1台で
  UserData がジョブごとに違うため、常設のスケーリンググループとは噛み合わない。
- **ECS / Fargate**。Wine + Xvfb + GPU 無しのソフトウェアレンダリングで長時間 CPU を
  張り付かせる用途で、Spot の単価優位を活かせる構成にならなかった。

## 影響範囲

- `apps/api/src/ec2.ts`（起動・UserData 組み立て・候補タイプの分散）
- `infra/`（Launch Template のみを定義。`infra/README.md`）
- **実行時起動の副作用として、ジョブレコードに `instanceId` が書かれる前に死ぬ
  インスタンスがありうる**。このため孤児掃除の Lambda はジョブレコードではなく
  AWS 上に実在するインスタンス（タグ `sattori:jobId`）を起点に走査する
  （Issue #23、`apps/api/README.md`「孤児インスタンスの検知」）。
- `AGENTS.md` §3
