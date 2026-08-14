# 調査レポート

数百行規模で、単一の調査として完結している長大なレポートの置き場
（`docs/documentation-guidelines.md` の分類 ④ のうち大きいもの）。**不変**で、
必要な人が1件だけ開く前提のためサイズ上限は無い。

規模が小さい実機検証・実測は [`../reports/`](../reports/README.md) へ置く。違いは規模と
粒度だけなので、迷ったら `reports/` でよい。

## 一覧

| 調査日 | 内容 | 結論 |
| --- | --- | --- |
| [2026-07-27](aws-region-cost-analysis.md) | AWSリージョン移行のコスト検討（商用34リージョン全件） | 2026-08-03 の追記で結論を撤回し `eu-south-2` へ移設（[decisions/0001](../decisions/0001-region-eu-south-2-ses-us-east-1.md)） |
