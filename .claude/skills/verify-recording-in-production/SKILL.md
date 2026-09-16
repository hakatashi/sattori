---
name: verify-recording-in-production
description: 未マージのPR(新タイトル対応等)を、公開フロントエンドには一切見せないまま本番AWS環境にデプロイしてE2E検証する手順。「本番でE2Eテストして」「マージ前に本番環境で確認して」等で使う。バックエンド(Lambda・ワーカーイメージ・タイトル資産)だけ先出しし、フロントエンドは`main`ブランチのビルドのままにすることで一般ユーザーには機能を見せず、直接APIを叩いて録画ジョブを作成・検証する。デプロイ順序とフロントエンドの隠し方を誤ると機能が一般公開されてしまうため、必ずこの手順に従うこと。
---

# 本番環境でのE2E検証(フロントエンド非公開のまま)

新機能(新タイトル対応等)のPRをレビュー・マージする前に、実際のAWS本番インフラ
(EC2・Step Functions・SES等)を使ったE2E検証を行いたいが、**一般ユーザーにはまだ
その機能を見せたくない**場合の手順。バックエンド(Lambda・ワーカーイメージ・
タイトル資産)だけを先にデプロイし、公開フロントエンド(CloudFront配信の静的サイト)
は`main`ブランチのビルドのまま維持することで、機能を隠したままバックエンドの
動作を直接API経由で検証する。

**本番AWSへの実デプロイ・実課金を伴う**。ユーザーから明示的に依頼された場合のみ
実行すること。

## 0. なぜフロントエンドだけ隠せるのか

`infra/lib/sattori-stack.ts`は`apps/web/dist`をビルド時ではなく**デプロイ実行時に
ディスク上にある内容**で読み取り、`BucketDeployment`でS3/CloudFrontへ配信する
(`WEB_DIST = join(HERE, "../../apps/web/dist")`)。一方 Lambda(`NodejsFunction`)は
**現在チェックアウトされているソースから毎回esbuildで新規バンドル**する。

この2つが独立しているため、「`apps/web/dist`だけ`main`ブランチ相当のビルドに
差し替えてから`cdk deploy`する」ことで、Lambda/ワーカーはPRブランチの新機能を含み、
公開フロントエンドだけは新機能を含まない状態を1回のデプロイで両立できる。

**新タイトル対応の場合、`packages/shared`の`SUPPORTED_GAME_IDS`が唯一の実質的な
ゲート**である(`isSupportedGame()`)。`GAME_IDS`/`GAME_TITLES`（リプレイパーサーが
認識するタイトル一覧）は`SUPPORTED_GAME_IDS`と別物で、多くの場合PRより前から
新タイトルを認識している（パーサー対応が先行しているため）。**隠せているかどうかは
`SUPPORTED_GAME_IDS`の内容だけで決まる**——`apps/web`側のUI変更（`GameInfoPage.tsx`の
バージョン情報・`changelog.ts`のお知らせ等）は表示上の演出に過ぎず、それらを戻し忘れても
機能自体の露出には直結しない（が、隠す意図と矛盾するため戻しておくのが望ましい）。

## 1. 前提

- 対象PRのブランチをチェックアウト済みで、ローカル検証(`verify-recording-locally`
  skill等)を済ませていること。
- 新タイトルの場合、タイトル資産(ゲーム本体・WINEPREFIX・MODビルド成果物)が
  ローカルに揃っていること(`upload-title-assets` skillの前提と同じ)。
- GPU系タイトル(g6f系)の場合、**本番のG系インスタンスクォータは共有資源**
  (`AGENTS.md`のth06nc等の教訓)。検証中に同じクォータを使う本番ジョブ・他の検証
  ジョブと衝突しないか確認すること(`aws ec2 describe-instances`で`g6f.*`の
  稼働状況を確認)。**同じクォータを共有する複数リプレイを検証する場合は、
  並列ではなく逐次実行すること**。

## 2. タイトル資産のアップロード・ワーカーイメージのビルド/push

新タイトル対応の場合、通常のデプロイ手順をそのまま行う(隠すのはフロントエンドだけ):

```bash
# タイトル資産(ゲーム本体・WINEPREFIX・MOD)
# → upload-title-assets skill の手順どおり
source scripts/sattori-env.sh
tar -czf /tmp/<game>-assets.tar.gz ... # skill参照
aws s3 cp /tmp/<game>-assets.tar.gz "s3://${SATTORI_TITLE_ASSETS_BUCKET}/titles/<game>/assets.tar.gz"

# ワーカーイメージ(GPU系タイトルならworker-gpu、CPU系ならworker)
# → deploy-sattori skill §2 の手順どおり
docker build -f worker/Dockerfile.gpu -t "${SATTORI_ECR_GPU_REPO}:latest" worker/
aws ecr get-login-password --region "$SATTORI_REGION" \
  | docker login --username AWS --password-stdin "${SATTORI_AWS_ACCOUNT_ID}.dkr.ecr.${SATTORI_REGION}.amazonaws.com"
docker push "${SATTORI_ECR_GPU_REPO}:latest"
```

## 3. フロントエンドを「隠した」状態でビルドする(git worktree)

**PRブランチの作業ツリーは一切変更しない**(ソースを一時的に書き換えて戻す方式は
戻し忘れのリスクがあるため避ける)。代わりに`main`ブランチを別ディレクトリへ
worktreeとしてチェックアウトし、そちらでフロントエンドをビルドしてから
`apps/web/dist`だけをコピーする。

```bash
cd <repo-root>
git fetch origin main
git worktree add /tmp/sattori-main-worktree main

cd /tmp/sattori-main-worktree
pnpm install
pnpm build   # apps/web/dist が main 相当(新機能を含まない)の内容で生成される

# 生成された dist だけを PR ブランチの作業ツリーへコピーする
rsync -a --delete /tmp/sattori-main-worktree/apps/web/dist/ <repo-root>/apps/web/dist/
```

**必ず確認すること**(コピー後、`cdk deploy`の前に):

```bash
# 新タイトルのGameIdが SUPPORTED_GAME_IDS の文脈で出てこないか確認する
# (GAME_IDS/GAME_TITLES側での出現は無害。前後の並びでSUPPORTED_GAME_IDS配列か判別する)
grep -o 'th06[^;]\{0,150\}th128' <repo-root>/apps/web/dist/assets/*.js
```

worktreeは検証終了まで残しておいてよい(再デプロイ時に使い回せる)。完全に不要に
なったら`git worktree remove /tmp/sattori-main-worktree`で片付ける。

## 4. デプロイ

`<repo-root>`(PRブランチ)で実行する。Lambdaは現在のブランチのソースから
ビルドされ、フロントエンドは§3でコピーした「隠した」distがそのまま使われる
(`apps/web`を再ビルドしないこと——再ビルドすると新機能入りのdistで上書きされる)。

```bash
source scripts/sattori-env.sh
pnpm run deploy   # cdk deploy --all
```

デプロイ後、公開サイトの配信バンドルに新機能が含まれていないことを直接確認する:

```bash
curl -s https://sattori.hakatashi.com/ | grep -oP '(?<=src=")[^"]*main-[^"]*\.js' | head -1
# 上記パスを使って
curl -s "https://sattori.hakatashi.com<パス>" | grep -c "<新GameId等の文字列>"
# 0件であることを確認
```

## 5. 直接APIを叩いてジョブを作成する(隠したUIを経由しない)

フロントエンドが機能を見せないため、`apps/web`のUIからは新タイトルのジョブを
作成できない。**実際のユーザーフローと同じAPI呼び出しをcurlで直接行う**ことで
検証する(`packages/shared/src/api.ts`の契約どおり)。

```bash
API=$(aws cloudformation describe-stacks --region "$SATTORI_REGION" --stack-name SattoriStack \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)

# 1. 署名付きアップロードURLを取得
REPLAY_PATH=packages/replay-parser/test-fixtures/<game>/<file>.rpy
SIZE=$(stat -c %s "$REPLAY_PATH")
resp=$(curl -s -X POST "$API/uploads" -H "content-type: application/json" \
  -d "{\"filename\":\"$(basename "$REPLAY_PATH")\",\"size\":$SIZE}")
REPLAY_KEY=$(echo "$resp" | python3 -c "import json,sys;print(json.load(sys.stdin)['replayKey'])")
UPLOAD_URL=$(echo "$resp" | python3 -c "import json,sys;print(json.load(sys.stdin)['uploadUrl'])")

# 2. S3へ直PUT
curl -s -X PUT "$UPLOAD_URL" -H "content-type: application/octet-stream" \
  --data-binary @"$REPLAY_PATH" -w "\nHTTP:%{http_code}\n"

# 3. マジックリンクをリクエスト(実メールアドレス宛。ユーザー自身のメールを使うこと)
curl -s -X POST "$API/magic-links" -H "content-type: application/json" -d "{
  \"replayKey\": \"$REPLAY_KEY\",
  \"options\": {\"watermark\": true, \"slowMotion\": false, \"th10BugfixMarisaB\": false, \"th06ncHighResolution\": false},
  \"email\": \"<user's email>\",
  \"language\": \"ja\"
}"
```

`jobId`はAPIレスポンスには含まれない(`decisions/0004`、jobId自体が認可の秘密値)。
**メール本文のリンクからしか分からない。** DynamoDBを直接scanしたりSSMの管理画面
トークンを取得して`/admin/jobs`を使ったりする経路は、この用途では権限上ブロック
される想定で試みるべきではない(実ユーザーと同じ経路で検証することが本来の目的
でもある)。Gmail連携がある場合は以下のように探す:

```
search_threads(query: "subject:録画を開始するリンク newer_than:10m")
→ 該当メッセージのidをget_message(messageFormat: PLAIN_TEXT)で開き、
  本文中の https://sattori.hakatashi.com/jobs/<jobId> からjobIdを取り出す
```

```bash
# 4. 録画を開始する
JOB_ID=<メールから取得したjobId>
curl -s -X POST "$API/jobs/$JOB_ID/start" -w "\nHTTP:%{http_code}\n"

# 5. ポーリングで状態を確認する(GetJobResponse。desyncDetected/timedOutも含む)
curl -s "$API/jobs/$JOB_ID" | python3 -m json.tool
```

進行中のジョブが使っているEC2インスタンスは以下で確認できる(GPU系クォータの
衝突確認・録画時間の把握用):

```bash
aws ec2 describe-instances --region "$SATTORI_REGION" \
  --filters "Name=tag:sattori:jobId,Values=$JOB_ID" \
  --query 'Reservations[].Instances[].{Id:InstanceId,Type:InstanceType,State:State.Name,AZ:Placement.AvailabilityZone}' \
  --output table
```

長時間(フル尺録画は数十分)かかるため、Monitorツール等で状態変化(`status`の
遷移)をポーリングし、`done`/`failed`になったら結果を確認する。

## 6. 結果の検証

`GetJobResponse`（手順5の最終ポーリング結果）で以下を確認する:

- `status === "done"`
- `downloadUrl`/`downloadUrl720p`が発行されている（実際にダウンロードして再生し、
  映像・音声・尺を目視確認する）
- `desyncDetected === false`（記録スコアとの一致。`null`は検証不能を意味し
  即NGではないが、想定外の場合は原因を確認する）
- `timedOut === false`
- タイトル固有の理論尺比較(リプレイの`frameCount`/60 と実際の録画時間)を、
  `docs/decisions/`・`worker/docs/titles/thNN.md`にある既知の許容範囲と照らして確認する

## 7. 後始末

- **バックエンド(Lambda・ワーカーイメージ・タイトル資産)はそのまま残してよい**
  ——フロントエンドが隠れている限り一般ユーザーには影響しない。
- 使い終わった`git worktree`は`git worktree remove /tmp/sattori-main-worktree`で
  削除する。
- **PRがマージされたら、通常のデプロイ手順(`pnpm build && pnpm run deploy`、
  `deploy-sattori` skill)を1回行うこと**。`apps/web/dist`をPRブランチ(マージ後は
  `main`)から正しく再ビルドしないと、隠したままのフロントエンドが本番に残り続ける。
- 検証専用に作ったジョブ(テスト用リプレイの録画結果)は、通常の運用と同じ
  出力バケットのライフサイクルルールで自動的に消える。手動削除は不要。

## 関連

- タイトル資産のアップロード → `upload-title-assets` skill
- ワーカーイメージのビルド・push・通常デプロイ → `deploy-sattori` skill
- ローカルでの事前検証 → `verify-recording-locally` skill
- API契約の全体 → `packages/shared/src/api.ts`
- jobIdを秘密値として扱う設計根拠 → `docs/decisions/0004-job-id-as-authorization-secret.md`
