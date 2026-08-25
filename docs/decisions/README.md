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
| [0011](0011-replay-end-template-matching.md) | 2026-07 | worker | リプレイの終了検知を画面静止ではなくリプレイ選択画面テンプレートとの照合で行う | 有効 |
| [0012](0012-crop-geometry-after-window-stabilizes.md) | 2026-08 | worker | x11grab のクロップ座標はウィンドウ発見時ではなく座標が安定してから確定する | 有効 |
| [0013](0013-per-job-pulseaudio-sink.md) | 2026-08 | worker | 並列録画の音声混成をジョブ専用の PulseAudio sink で防ぐ | 有効 |
| [0014](0014-slow-motion-scaling-across-pipeline.md) | 2026-08 | worker / apps/web | 低速録画の倍率をフック・監視・変換・品質チェックのすべてへ一貫して適用する | 有効 |
| [0015](0015-resume-from-raw-video-checkpoint.md) | 2026-08 | worker / apps/api | リトライ時の再開可否は S3 の生動画の実体で判定し、録画時の倍率はそのオブジェクトに添えて運ぶ | 有効 |
| [0016](0016-ec2-fleet-instance-type-diversification.md) | 2026-08 | apps/api | EC2 Fleet の候補インスタンスタイプはタイトルごとに実機検証で決める | 有効 |
| [0017](0017-orphan-sweep-from-aws-instances.md) | 2026-08 | apps/api | 孤児インスタンスの掃除はジョブレコードではなく AWS 上の実インスタンスを起点に走査する | 有効 |
| [0018](0018-home-worker-pull-assignment.md) | 2026-08 | apps/api / home-worker | 自宅ワーカーへの割り当ては Pull 型にし、競合はすべて条件付き更新で決着させる | 有効 |
| [0019](0019-userdata-ecs-agent-off-and-bootstrap-failure-notification.md) | 2026-07 | apps/api | UserData で ECS エージェントを止め、コンテナ起動前の失敗は UserData 自身が通知する | 有効 |
| [0020](0020-worker-env-redaction-enforced-by-type.md) | 2026-08 | apps/api / packages/shared | taskToken の秘匿は散文の約束ではなく型で強制する | 有効 |
| [0021](0021-cost-estimation-side-data-never-fails-the-job.md) | 2026-08 | apps/api | コスト推定用の付随データは、取得に失敗してもジョブを落とさず、後から上書きしない | 有効 |
| [0022](0022-cost-guard-by-estimated-amount-not-job-count.md) | 2026-07 | apps/api | 新規受付の自動停止は録画回数ではなく推定コスト額で判定する | 有効 |
| [0023](0023-elapsed-time-interpolation-never-rewinds.md) | 2026-08 | apps/web / worker | 経過時間表示はサーバー値を上限とする内挿にし、決して巻き戻さない | 有効 |
| [0024](0024-cookieless-analytics-beacon.md) | 2026-08-16 | apps/web / apps/api / packages/shared / infra | アナリティクスはCookie無しの自前ビーコンで実装し、国はCloudFront経由で取る | 有効 |
| [0025](0025-ops-alerts-per-region-sns-topics.md) | 2026-08-16 | infra / apps/api | 運用アラート通知は1本の宛先に統一しつつ、SNSトピック自体はリージョンごとに分ける | 有効 |
| [0026](0026-hashed-visitor-id-daily-salt.md) | 2026-08-16 | apps/api / infra | ユニーク訪問者数はIPを日次saltでハッシュ化した仮の訪問者IDで数える | 有効 |
| [0027](0027-lambda-alarms-account-wide-not-per-function.md) | 2026-08-19 | infra | Lambdaのエラー・スロットルアラームは関数ごとではなくアカウント全体集計に1本ずつ張る | 有効 |
| [0028](0028-home-worker-container-network-check.md) | 2026-08-24 | home-worker / apps/api | 自宅ワーカーは新規claim前に「コンテナのネットワーク名前空間」からAWSへの疎通を確認する | 有効 |
| [0029](0029-analytics-aggregation-daily-only-uniques.md) | 2026-08-25 | apps/api / packages/shared / apps/web / infra | 訪問者アナリティクスの集計はパーティション単位のQueryで行い、ユニーク訪問者数は日次のみ意味を持たせる | 有効 |
| [0030](0030-cloudfront-measured-usage-best-effort.md) | 2026-08-25 | apps/api / packages/shared / infra | CloudFrontの実配信量はCloudWatchから取得する付随データとし、失敗しても集計APIを壊さない | 有効 |
| [0031](0031-stalled-job-sweep-by-status.md) | 2026-08-26 | apps/api / packages/shared / infra | 非終端のまま固まったジョブは、ジョブレコードのstatusを起点に既存の孤児EC2掃除Ruleへ相乗りして定期掃除する | 有効 |
| [0032](0032-replay-info-server-side-reparse-only.md) | 2026-08-26 | apps/api | replayInfo/game/estimatedDurationSecondsはクライアント申告値を使わずサーバー側で再パースする | 有効 |
| [0033](0033-admission-control-split-magic-link-vs-start-job.md) | 2026-08-26 | apps/api | 受付制御（キルスイッチ・月間コストガード）はrequestMagicLinkとstartJobで非対称にチェックする | 有効 |
| [0034](0034-launch-handlefailure-timing.md) | 2026-08-26 | apps/api | Launch/HandleFailureの判定タイミングは早期失敗通知の遅延と書き込み競合を考慮して決める | 有効 |

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
