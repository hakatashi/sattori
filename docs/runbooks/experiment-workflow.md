# 技術検証の進め方（実験ジョブ・検証用イメージ・不採用コード）

録画パイプラインの新しい技術（キャプチャ方式・インスタンスタイプ・MOD・ワーカーイメージ）を検証するときの
運用ルール。**検証は sattori のブランチの上で、本番パイプラインに直接手を入れて行い、合格したらそのまま本番へ
取り込む**。旧 touhou-recorder（TR）のように別リポジトリ・手作業のEC2で検証しない
（経緯と根拠は [`docs/decisions/0075`](../decisions/0075-experiment-jobs-and-experimental-ecr.md)、Issue #397）。

## 目次

- [1. 検証の基本方針](#1-検証の基本方針)
- [2. クラウドで検証する（実験ジョブ）](#2-クラウドで検証する実験ジョブ)
- [3. 検証用のワーカーイメージ](#3-検証用のワーカーイメージ)
- [4. このマシン（自宅ワーカー機）で検証する](#4-このマシン自宅ワーカー機で検証する)
- [5. 採用しなかったコードの扱い](#5-採用しなかったコードの扱い)
- [6. 検証レポート](#6-検証レポート)
- [7. 検証中に守る共通ルール](#7-検証中に守る共通ルール)

## 1. 検証の基本方針

- 検証のコードは**ブランチ上で本番のコードを直接書き換えて**書く（別のスクリプトを作らない）。録画は本番の
  ワーカー（`worker/`）を通す。
- 検証の切り替えは**起動側から渡す環境変数**（`captureMode` のような段の属性、`apps/api/src/workerEnv.ts`）で
  表す。**ワーカーの中に「実験か本番か」「自宅かEC2か」の分岐を作らない**（AGENTS.md §3）。
- 録画パイプラインの変更・新しい作品タイトルの追加は、クラウドでの実機検証を経ること（AGENTS.md §3）。
  **フレーム同期の段のインスタンスタイプは品質に影響せず速度だけが変わる**ので、足すときは綿密な検証をせず、
  必要なら実験ジョブで簡単な速度検証だけする。`.2xlarge`帯の`c7i`/`c7a`/`m7i`と`c7i.4xlarge`は運用実績があり検証不要
  （[`0078`](../decisions/0078-frame-sync-plan-and-instance-type-verification-policy.md)）。実時間の段は従来どおり。裏付けは
  [`docs/reports/`](../reports/README.md) に残す。
- **手作業でEC2・SG・キーペア・ECRを作らない**。クラウドでの検証は §2 の実験ジョブに寄せる。TR の
  `research/touhou-recorder/cloud/`（terraform）と `docs/aws-resources.md` は記録であって、使わない。

## 2. クラウドで検証する（実験ジョブ）

管理API（`/admin/*`、SSMの共有トークン。[`apps/api/docs/admin-api.md`](../../apps/api/docs/admin-api.md) §10）で、
**段を明示した録画ジョブ**を投げる。通常のジョブと同じStep Functions・孤児掃除・コスト推定・ログ
（`/sattori/worker`）・進捗プレビューに乗る。完了メールは送られない。

```bash
# リプレイは、既存ジョブのもの（sourceJobId）か、POST /uploads で上げたもの（replayKey + game）
curl -sS -X POST "$API/admin/experiments" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{
  "sourceJobId": "<既存のjobId>",
  "step": { "kind": "ec2", "platform": "cpu", "region": "eu-south-2",
            "instanceTypes": ["c7i.4xlarge"], "captureMode": "realtime", "speed": 1 },
  "workerImageTag": "exp-framesync-1",
  "note": "frameSync 検証 1回目"
}'
# 結果（品質の判定値・実時間・尺比・課金時間・推定コスト）をまとめて取得
curl -sS "$API/admin/experiments" -H "Authorization: Bearer $ADMIN_TOKEN"
```

- **段は1つだけ**。使い切ったら（Spot在庫の枯渇など）ほかの段へ落ちず`capacity_exhausted`で失敗する。
  フォールバックの挙動を見たいときは本番のタイトルの段（通常のジョブ）で見る。
- 自宅ワーカーを試すときは `"step": {"kind": "home", ...}`（検証用イメージとは併用できない。§3）。
- GPUの段は、インスタンスタイプを `GPU_INSTANCE_TYPE_VCPUS`（`packages/shared/src/gpuQueue.ts`）へ足してから。
- GPUの待ち行列に優先度は無い（FIFO）。GPUが混んでいる間は待つ。
- 管理設定の「GPUの段を飛ばす」「GPUのフォールバック先から試す」は実験ジョブにも効く。GPUの実験の前に確認する。
- 品質の判定値は `desyncDetected`（スコア不一致）と `timedOut`（終了検知できずタイムアウト）だけ。重複フレーム率など
  録画ごとの詳細は `GET /admin/jobs/{jobId}/logs`（ワーカーログ）にあり、**重複フレーム率は倍速・低速・
  フレーム同期の品質判定に使わない**（`docs/known-limitations.md` §3）。理論尺（frameCount/60）との比較を併用する。
- 実験ジョブのレコードは本番のDynamoDBに残る。管理画面の一覧では `experiment` 付きで見分けられる。
- `verify-recording-in-production` skill（未マージPRのバックエンドだけを先に出す）との違い: あちらは**PRの
  Lambda・ワーカーを本番へデプロイして**通常のジョブで確認する。実験ジョブは**デプロイ済みの本番に、検証用の
  イメージ・段を指定して**投げる。ワーカーイメージだけを差し替える検証なら、デプロイ不要で実験ジョブが軽い。

## 3. 検証用のワーカーイメージ

- 本番のECR（`sattori-worker`・`-gpu`）は**2イメージしか保持しないので、検証用のタグを押してはならない**
  （本番のイメージが消える）。検証用は別のリポジトリ（CDK管理、4世代保持・タグ無しは1日で削除）:
  `sattori-worker-experimental`（CPU）・`sattori-worker-experimental-gpu`。
- push の手順は [`deploy-sattori` skill](../../.claude/skills/deploy-sattori/SKILL.md) §2.1。
  タグは `exp-<テーマ>-<連番>` のように検証ごとに分ける（`latest` は使わない。何を検証したか分からなくなる）。
- 実験ジョブの `workerImageTag` に押したタグを指定する。**使えるのは一次リージョン（eu-south-2）のEC2の段だけ**。
  フォールバック先（eu-north-1）と自宅ワーカーへは検証用イメージが届かない。
- **自宅ワーカーで検証用イメージを使う方法は無い**（自宅は本番ジョブを受け続けるので、デーモンの pull 対象を
  切り替えない）。自宅マシンでの検証は §4。
- GPUのAMIの検証は、従来どおり us-west-2 へAMIをコピーして行う（`build-gpu-worker-ami` skill）。検証用のAMIは作らない。

## 4. このマシン（自宅ワーカー機）で検証する

[`verify-recording-locally` skill](../../.claude/skills/verify-recording-locally/SKILL.md) に従う（本番のワーカー
イメージ、隔離したタイトル資産、`/mnt/cache3` 配下の保存先。`sattori-home-worker` を止めてから）。
検証用のワーカーイメージをローカルで使うなら、`docker build` したイメージをそのまま `docker run` する
（ECRへ push しなくてよい）。

## 5. 採用しなかったコードの扱い

- 不採用になったコード（採らなかった実装・実験用の改造）は、`research/archive/<テーマ>/` へ移す。
  [`research/archive/README.md`](../../research/archive/README.md) に置き場所の規則がある。
- 検証レポート（`docs/reports/`）から、そのディレクトリへ**パスでリンクを張る**。
  **commit hash で参照しない**: 公開ミラーは `git filter-repo` を通すので hash が変わり、公開側から辿れない。
- 診断用のプローブ（TR の `d3d9_probe`・`dsound_probe`・`timer_probe` など）は、本番のMODへ入れない。
  入れるなら `make DIAG=1` のときだけビルドする（Issue #393 の `diag/`）。
- 採用したコードは、ブランチ上の変更としてそのまま PR にする（コピーし直さない）。

## 6. 検証レポート

- 検証結果は `docs/reports/YYYY-MM-DD-<テーマ>.md`（日付ベース）に書く。**1検証1ファイル、書いたら不変**。
  実験ジョブの結果は `GET /admin/experiments` の値を貼る（jobId は伏せなくてよいが、公開リポジトリには
  載るので、**jobId は認可の秘密値**（[`0004`](../decisions/0004-job-id-as-authorization-secret.md)）のため
  短縮形か伏せ字にする）。
- TR の `reports/NN` の番号体系は **112（と追補）で凍結**する。新しいレポートに連番を振らない。
  過去の `touhou-recorder reports/NN` の参照は `research/touhou-recorder/reports/NN_*.md` を指す
  （[`0074`](../decisions/0074-import-touhou-recorder-snapshot.md)）。
- 検証で何かを決めたら、`docs/decisions/` にも書いて両者を相互にリンクする
  （`docs/documentation-guidelines.md` §2）。

## 7. 検証中に守る共通ルール

TR の `AGENTS.md`（`research/touhou-recorder/AGENTS.archived.md`）にあった共通ルールのうち、今も有効なもの。

- **`DISPLAY :20` を使わない**。このマシンでユーザーが使うリモートデスクトップの実セッションで、ゲーム画面を
  出すとユーザーの画面にウィンドウが出る。検証はXvfb上で完結させる。
- **wineserver / winedevice の後片付けを必ず実行する**（try/finally）。放置するとホストのsystem D-Busの
  メッセージキューが枯渇し、マシン全体がハングする（TR reports/55・Issue #186）。
- **並列実行は同時2インスタンスまで**。並列にする場合は WINEPREFIX とゲームディレクトリの両方を
  インスタンスごとに個別コピーする（共有すると固まる・壊れる）。
- **`pgrep -f` / `pkill -f` を使わない**。検査コマンド自身に一致して「実行中」と誤判定する（TR reports/91。
  録画完了に約40分気づかず、Spotを遊休のまま課金した）。`pgrep -x <プロセス名>`、`ps -eo comm,args` の行頭一致、
  完了マーカーで判定する。
- **録画した動画は `/mnt/cache3/sattori-<title>-verify/` 配下へ保存する**（ルートFSは逼迫しており、数GBの録画で
  ffmpegなどが異常終了する）。`verify-recording-locally` skill と同じ。
- **待機のマナー**: 長いジョブの完了待ちに、無意味なコマンドを毎ターン繰り返さない。待機ループを仕掛けて通知を待つ。
- **本番のタイトル資産キャッシュを直接使わない**（所有権が汚染され自宅ワーカーが壊れる。`verify-recording-locally` skill の隔離コピーに従う）。
- **自宅ワーカー機での検証は `sattori-home-worker` が停止していることを確かめてから**（エージェントが勝手に
  停止させない。稼働中ならユーザーに確認する）。
