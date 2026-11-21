# research/archive — 採用しなかった検証コード

技術検証（[`docs/runbooks/experiment-workflow.md`](../../docs/runbooks/experiment-workflow.md)）で**採用しなかった**
コードの置き場所。`research/touhou-recorder/`（旧 PoC のスナップショット）とは別で、こちらは sattori 上での
検証から生まれたもの。

## 規則

- 1テーマ1ディレクトリ: `research/archive/<テーマ>/`。中に `README.md`（何を試したか・なぜ採用しなかったか・
  元にした検証レポートへのリンク・動かすための前提）を置く。
- **検証レポート（`docs/reports/`）からここへパスでリンクを張る**。commit hash では参照しない
  （公開ミラーは `git filter-repo` を通すので hash が変わる）。
- ここに置いたコードはビルド・テスト・Dependabot の対象外にする（ワークスペースに入れない）。
- 公開してよいものだけを置く。アカウントID・リソースID・jobId 等は伏せる（`scripts/check-public-mirror.sh`）。

## 一覧

（まだ無い）
