# 0074. touhou-recorder を伏せ字化したスナップショットとして research/ へ取り込む

- **状態**: 有効
- **決定日**: 2026-11-21
- **対象**: research/touhou-recorder / docs
- **関連**: Issue #396、Epic #399、#395（公開ミラーの検査）、#397（棚卸し）、
  [`0004`](0004-job-id-as-authorization-secret.md)、`docs/documentation-guidelines.md` §4

## 背景

新しい技術の検証は private の `touhou-recorder`（TR）で行い、本番は sattori で実装する、という分担だった。
しかし TR の `recorder/` と本番の `worker/recording/` の差が大きくなり、採用した技術を作り直す手間と
sattori 側での検証のやり直しが毎回発生していた。以前の `documentation-guidelines.md` §4 は
「TR の `reports/NN` は別リポジトリのもので、こちらへは移設しない」と定めていた。

## 決定

- TR の現行ツリー（`223f266`、追跡ファイル439件）を、**履歴なしのスナップショット**として
  `research/touhou-recorder/` へ取り込む。ディレクトリ構成は変えない。
- 取り込む前に、AWS アカウントID・各種リソースID・本番ジョブID・自宅IP・GCP のプロジェクト名/番号を
  `<AWS_ACCOUNT_ID>` のような種類付きの伏せ字へ置換する（規則は `research/touhou-recorder/README.md`）。
  #395 の検査（`scripts/check-public-mirror.sh --tree`）で違反0件を確かめる。
  リバースエンジニアリングの記録とスクリーンショットは公開する（ユーザー確定、2026-11-20）。
- 本文の「touhou-recorder reports/NN」という書き方は**書き換えず**、ガイドライン §4 で
  `research/touhou-recorder/reports/NN_*.md` を指すと定義する。
- TR の `AGENTS.md` は `AGENTS.archived.md` に改名し、アーカイブの注記を付ける（常時ロードされて
  sattori のルールと矛盾するのを防ぐ）。`CLAUDE.md` は削除する。
- `research/` は `check:docs` のサイズ上限から除外する（reports/81 は607行）。
- 原本リポジトリは private のままアーカイブ（read-only）にする。この操作はユーザーが行う。

## 根拠

約890か所の参照を書き換えるより、参照先の定義を1か所直す方が安全で差分も小さい。履歴を持ち込まないので、
過去のコミットに残った識別子を伏せる必要がなく、検査の対象はツリーだけで済む。
コードを含むため `docs/` の下ではなくトップレベルの `research/` に置き、`docs/research/`
（Markdown の長大な調査）と区別した。

## 採らなかった選択肢

- **履歴ごと取り込む**: 292コミットの全リビジョンを伏せ字化する必要があり、漏れの検査も重くなる。
- **参照を `research/...` へ全面的に書き換える**: 約175ファイルの差分が出て、レビューもしにくい。
- **TR を別の公開リポジトリにする**: アカウント固有の記録が多く、伏せ字化の作業は同じだけ要る上、
  参照が外部リポジトリのままで検証のやり直しという問題が解決しない。

## 影響範囲

- 識別子が伏せ字になっているため、レポートの再現手順のうちアカウント固有の値はそのままでは使えない。
- `docs/aws-resources.md`（TR）は識別子がすべて伏せ字になった。残存リソースの棚卸しは #397。
- ルートの `AGENTS.md` §1・`README.md` の TR への言及を、取り込み後の記述へ改めた。
