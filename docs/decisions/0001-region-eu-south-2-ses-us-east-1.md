# 0001. リージョンを `eu-south-2` にし、SES と CloudFront 用 ACM だけ `us-east-1` に残す

- **状態**: 有効
- **決定日**: 2026-08-03
- **対象**: infra / apps/api / packages/shared
- **関連**: `docs/research/aws-region-cost-analysis.md`、touhou-recorder reports/42

本番リージョンを `us-east-1` から `eu-south-2`（スペイン）へ移設した。Spot 単価が
実測最安のため。ただし **eu-south-2 に SES は存在しない**ので、SES クライアントだけ
`us-east-1` に向けている。これを知らずに「全部 eu-south-2 に揃える」と完了メールが
送れなくなる。

## 背景

コストの7割超を EC2 Spot が占めており、Spot 単価はリージョン間で無視できない差がある
（`docs/research/aws-region-cost-analysis.md`）。当初のリージョンは `us-east-1` で、
2026-07-27 時点の調査は「移設は推奨しない」「`eu-south-2` は実質的に候補外」
「もし将来どうしても移すなら `us-east-2` 一択」と結論していた。

## 決定

**`eu-south-2` を本番リージョンとする**。移設は 2026-08 に実施した。

例外は2つで、どちらも `SattoriEdgeStack`（`us-east-1`）にまとめてある
（`infra/README.md`）。

- **SES**: eu-south-2 で提供されていない。`apps/api/src/ses.ts` が `SES_REGION`
  環境変数で送信先リージョンだけを切り替える。ドメイン検証・DKIM・サンドボックス解除は
  us-east-1 のものをそのまま使い続けている。
- **CloudFront 用 ACM 証明書**: CloudFront の仕様上 us-east-1 必須。

EC2 の候補インスタンスタイプも eu-south-2 で提供される `c7i` / `c7a` / `c7i-flex` へ
絞り直してある（`apps/api/src/ec2.ts`、`apps/api/README.md`）。

## 根拠

2026-07-27 の調査結論を撤回した理由は3つ。

1. **§7.2 で最大のリスクとされていた「録画品質の再検証」が解消した**。touhou-recorder
   `reports/42`（2026-07-31）が eu-south-2 実機で th06/07/08/11 すべてのフル尺録画を行い、
   重複フレーム率が us-east-1 のベースラインと同等かそれ以上に良好
   （0.1% / 0.2% / 0.2% / 4.5%）であることを確認した。
2. **§7.3 の「SES が実質的なブロッカー」という評価を採らなかった**。SES クライアントだけ
   us-east-1 に向ける構成は、調査レポート自身が「絶対的なブロッカーではない」と述べている
   回避策そのものであり、実装コストは小さい。
3. **正式リリース前であり、インフラの大きな移動を行うならリリース前が最適なタイミング**
   という判断を、§8.3 の「年 $231 の節約では検証工数に見合わない」という結論より優先した。
   リリース後の同一移設は、本番トラフィック・ユーザー影響・既存データ移行のコストが
   追加でかかる。

## 採らなかった選択肢

- **`us-east-1` に留まる**（2026-07-27 時点の推奨）。上記1〜3により撤回した。
- **`us-east-2` へ移す**（同レポートの次善案）。節約額では eu-south-2 に劣る。
- **SES ごと別サービス（SendGrid 等）へ移す**。AWS フルサーバーレスに統一する方針
  （`AGENTS.md` §3）を崩し、クロスクラウドの認証連携が増えるため。
- **全リージョンを us-east-1 のまま、EC2 だけ eu-south-2 で起動する**。S3・DynamoDB との
  クロスリージョン転送料と遅延が乗るため。

## 影響範囲

このトレードオフは**解消しておらず、既知のものとして受け入れている**。

- **Spot キャパシティプール数の後退**。eu-south-2 は `.xlarge` 9プール/3タイプ、
  `.2xlarge` 6プール/2タイプで、us-east-1 の 30/6・20/4 を大きく下回る。候補リストを
  絞った上でもプール数は us-east-1 の半分以下に留まる。**起動失敗率
  （`InsufficientInstanceCapacity` によるリトライ発生率）を監視すること**
  （`docs/known-limitations.md` §5）。

依存しているコード・ドキュメント:

- `apps/api/src/ses.ts`（`SES_REGION`）、`apps/api/src/ec2.ts`（候補インスタンスタイプ）
- `infra/`（`SattoriEdgeStack` と本体スタックの分割。`infra/README.md`）
- `packages/shared/src/cost.ts`（単価定数が eu-south-2・2026-08-03 時点のもの。
  リージョンを変えるなら**必ず併せて見直す**。`docs/known-limitations.md` §7）
- `AGENTS.md` §2
