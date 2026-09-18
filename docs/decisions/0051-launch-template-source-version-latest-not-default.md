# 0051. EC2 Launch Templateのバージョン継承元を`$Default`ではなく`$Latest`にする

- **状態**: 有効
- **決定日**: 2026-09-17
- **対象**: apps/api
- **関連**: Issue #82、`docs/reports/2026-09-17-th15-production-e2e-attempt.md`

`apps/api/src/ec2.ts`の`launchRecordingInstance()`が`CreateLaunchTemplateVersion`で
継承元に指定する`SourceVersion`を、`"$Default"`から`"$Latest"`に変更する。

## 背景

th15のGPU用カスタムAMI更新を`cdk deploy`で反映しようとしたところ、実際のジョブ起動には
一切反映されないことが発覚した。原因は、CloudFormationの`AWS::EC2::LaunchTemplate`
（`infra/lib/sattori-stack.ts`の`CfnLaunchTemplate`）がプロパティ変更のたびに新しい
バージョンを作成するだけで、**そのバージョンを`DefaultVersionNumber`へ自動的には
昇格しない**こと。`ModifyLaunchTemplate`による明示的な昇格が必要だが、CDK側にその
仕組みは無い。

`launchRecordingInstance()`は毎回のジョブ起動で`SourceVersion: "$Default"`を指定して
いたため、**スタック作成時点の最初のバージョンが`$Default`のまま永久に固定され**、
以降のCDKデプロイでLaunch Template（AMI・その他プロパティ）を変更しても、実際の
ジョブ起動には一切反映されない状態だった。th06nc用GPU Launch Templateは構築以来
一度もAMIを変更したことが無かったため、`$Default`が偶然正しい値のまま気づかれずに
済んでいた（CPU系Launch Templateも同じ構造の問題を抱えているが、AMIはSSMパラメータ
経由でECS最適化AL2023を動的解決する運用のため顕在化しにくい）。

## 決定

- `SourceVersion`を`"$Latest"`に変更する。`"$Latest"`は直前に作成された最新
  バージョン（CDKデプロイが作ったものであれ、ジョブ起動自身が作ったものであれ）を
  常に指すため、CDKデプロイの内容が次のジョブ起動から確実に継承される。

## 根拠

- th15のGPU用カスタムAMI更新が実際のジョブに反映されないことを実機で確認
  （`docs/reports/2026-09-17-th15-production-e2e-attempt.md`）。

## 採らなかった選択肢

- **CDKデプロイ後に`ModifyLaunchTemplate`で明示的に`$Default`を昇格する（カスタム
  リソース等を追加する）**: `"$Latest"`への変更1行で同じ効果が得られるため、
  実装・運用コストに見合わないと判断した。

## 影響範囲

- `apps/api/src/ec2.ts`（CPU系・GPU系Launch Template両方に効く）。
- **`$Latest`は「直前に作られたバージョン」を指すだけで、内容の正しさを保証しない**。
  この修正が有効になる前（旧コードが`$Default`のままバージョンを作り続けていた間）に
  作られた`$Latest`は誤ったAMIを指したままになりうる（「`$Latest`の汚染」、
  上記レポート参照）。Launch Templateのプロパティを次に変更する際は、デプロイ直後に
  `aws ec2 describe-launch-template-versions --versions '$Latest'`で内容を確認すること。
