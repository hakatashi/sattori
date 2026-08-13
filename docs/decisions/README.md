# 決定記録（軽量 ADR）

「なぜこうなっているか」「これをやると壊れる」を1決定1ファイルで残す場所
（`docs/documentation-guidelines.md` の分類 ②）。**まずこのページの一覧だけを読み、
関係する1件だけを開くこと。**

各パッケージの `README.md` は「今どうなっているか」（① 参照仕様）しか書かない。
仕様だけを読んで推測で変更すると、過去に踏んだ地雷を踏み直すので、README 側からここへの
リンクがあれば必ず辿ること。

## 一覧

| # | 決定日 | 対象 | 内容 | 状態 |
| --- | --- | --- | --- | --- |
| [0001](0001-region-eu-south-2-ses-us-east-1.md) | 2026-08-03 | infra / apps/api | リージョンを `eu-south-2` にし、SES と CloudFront 用 ACM だけ `us-east-1` に残す | 有効 |
| [0002](0002-ec2-launch-at-runtime-not-iac.md) | 2026-06 | infra / apps/api | EC2 の起動だけは IaC ではなく実行時に AWS SDK で行う | 有効 |
| [0003](0003-worker-python-home-worker-typescript.md) | 2026-07 | worker / home-worker | 録画ワーカーだけ Python にし、自宅ワーカーの常駐デーモンは TypeScript にする | 有効 |
| [0004](0004-job-id-as-authorization-secret.md) | 2026-06 | apps/api / apps/web | jobId 自体を認可の秘密値として使う | 有効 |
| [0005](0005-admin-auth-ssm-shared-token.md) | 2026-07 | apps/api / infra | 管理画面の認証は Cognito ではなく SSM の共有トークンにする | 有効 |
| [0006](0006-progress-polling-not-websocket.md) | 2026-06 | apps/web / apps/api | 進捗表示は単純なポーリングにし、WebSocket / SSE を使わない | 有効 |
| [0007](0007-no-ip-rate-limit-no-recaptcha.md) | 2026-07 | apps/api | IP 単位のレート制限・reCAPTCHA を見送る | 有効 |
| [0008](0008-th20-appdata-resolved-from-unix-user.md) | 2026-08 | worker | th20 の `%APPDATA%` 配置先を実行中の UNIX ユーザーから解決する | 有効 |
| [0009](0009-thprac-post-attach.md) | 2026-08 | worker / apps/web | th20 のデシンク対策に thprac を「後付けアタッチ」で適用する | 有効 |
| [0010](0010-slow-motion-no-worker-side-branching.md) | 2026-08 | worker / apps/api | 低速録画をワーカー側の分岐にせず、起動側が渡す環境変数だけで表す | 有効 |

## 書き方

- ファイル名は `NNNN-kebab-case-title.md`（4桁の連番）。**番号は既存の最大値+1**を採る。
  日付順ではなく作成順なので、番号が飛んでいても詰めない。
- [`TEMPLATE.md`](TEMPLATE.md) をコピーして書き始める。書式の詳細は
  [`../documentation-guidelines.md`](../documentation-guidelines.md) §5.2。
- **新規追加したら上の一覧にも必ず1行足すこと**。一覧に載っていない決定記録は、
  エージェントからは存在しないのと同じである。
- **README（① 参照仕様）側からもリンクを張る**（同ガイドライン §5.5）。
  リンクを張らずに情報をここへ移すのは、削除と大差ない。

## 決定が覆されたとき

**元のファイルを削除・書き換えしない**。`状態` を「`NNNN` によって置き換え済み」に変え、
新しい番号で新規ファイルを作り、この一覧の `状態` 欄も更新する。

覆された決定とその理由が残っていること自体が、同じ検討を繰り返さないための情報である
（「昔なぜそうしなかったか」は再検討時に最も価値が高い）。
