---
name: verify-recording-locally
description: このマシン(HakataMatrix、自宅ワーカー本体)で本番ワーカーイメージを使い、特定のリプレイをローカルDocker上で録画検証する手順。本番ジョブの失敗(fps暴走・処理落ち・デシンク等)がリプレイ固有の現象か環境ノイズかを切り分けたいとき、新タイトル・新リプレイの動作確認をしたいときに使う。「ローカルで録画検証して」「このリプレイが本当に暴走するか確認して」等で使う。sattori-home-workerとの資源競合・タイトル資産キャッシュの汚染を避ける手順を踏まないと自宅ワーカー本体の運用を壊すため、必ずこの手順に従うこと。
---

# 録画のローカル検証(このマシン上)

本番ワーカー(`worker/`)と全く同じ ECR イメージ・全く同じ録画パイプラインを、AWS の
S3/DynamoDB/Step Functions を一切介さずこのマシン上の Docker で動かし、特定のリプレイの
録画結果を直接目視確認する手順。**このマシン(HakataMatrix)自体が自宅ワーカー本体**
(`sattori-home-worker.service`、`home-worker/README.md`参照)である
ため、資源競合とキャッシュ汚染を避ける下記の手順を必ず踏むこと。

`worker/README.md` §11・[`docs/runbooks/worker-local-recording.md`](../../docs/runbooks/worker-local-recording.md)
の「AWS 無しのベアメタル直接実行」と目的は同じだが、こちらは**Dockerコンテナ内で実行する**
(ホスト直接実行はWineプロセス残留によるsystemdハング事故の前例があり、
[`decisions/0035`](../../docs/decisions/0035-outer-timeout-wrapper-for-bare-metal-runs.md)
の外側タイムアウトラッパーだけでは防ぎきれないリスクがあるため、コンテナの`--rm`による
確実な後始末を優先する)。

## 0. 前提: sattori-home-worker が停止していることを確認する

自宅ワーカーは常駐デーモンとして本番ジョブを受け付け続けており、検証用コンテナと
Wine/Xvfb/PulseAudio・GPU・CPUを取り合う。**検証を始める前に必ず停止していることを
確認すること**(エージェントが勝手に停止させてはいけない。稼働中なら、止めてよいか
ユーザーに確認する)。

```bash
systemctl is-active sattori-home-worker   # "inactive" であることを確認
```

稼働中だった場合は、検証を始めずユーザーに確認する。検証終了後にサービスを再開するか
どうかも、こちらから停止していない限りは判断不要(停止させたのがユーザー自身の別の
理由によるものかもしれないため)。

## 1. 環境値の解決

```bash
source scripts/sattori-env.sh
# SATTORI_REGION / SATTORI_AWS_ACCOUNT_ID / SATTORI_TITLE_ASSETS_BUCKET /
# SATTORI_UPLOAD_BUCKET / SATTORI_JOBS_TABLE / SATTORI_ECR_REPO が使えるようになる
```

## 2. 検証対象リプレイの入手

本番の失敗ジョブを調査する場合は、まず DynamoDB でジョブレコードを引き、`replayKey`(と
`game`)を確認してから S3 からダウンロードする(ジョブ調査の一般手順は
`docs/runbooks/ops-alerts.md`参照)。

```bash
aws dynamodb get-item --region "$SATTORI_REGION" \
  --table-name "$SATTORI_JOBS_TABLE" \
  --key '{"jobId": {"S": "<jobId>"}}'

aws s3 cp "s3://${SATTORI_UPLOAD_BUCKET}/<replayKey>" /tmp/verify/replay.rpy \
  --region "$SATTORI_REGION"
```

ユーザーから直接 `.rpy` ファイルを渡された場合はダウンロードを飛ばしてよい。

## 3. 検証用ディレクトリの準備(`/mnt/cache3` 配下)

検証データ(録画動画・診断スナップショット・ログ)は `/mnt/cache3` 配下に保存する
(ユーザーが視聴できるようにするため。`/` パーティションは空き容量が少ないので大きな
mp4 を置かない)。`/mnt/cache3` は `hakatashi` 所有なので、直下に検証用ディレクトリを
そのまま作ってよい。

```bash
mkdir -p /mnt/cache3/sattori-<game>-verify/repro-<jobId>
```

## 4. タイトル資産を隔離コピーする(本番キャッシュを直接使わない)

自宅ワーカーのタイトル資産キャッシュ(`/home/hakatashi/.cache/sattori-home-worker/title-assets/<game>/`)
には既に展開済みの WINEPREFIX・ゲーム本体・MOD が入っており、これを直接マウントして
使い回すこともできるが、**過去に世代ディレクトリの所有権が汚染され自宅ワーカーの本番
録画が全滅した事故がある**(2026-09-03、th06。世代ディレクトリが`root`以外の所有に
なるとwineserverが`not owned by you`で拒否する)。検証用の
コンテナ実行(root権限で書き込む)が万一キャッシュを壊すと本番に影響するため、**必ず
`/mnt/cache3` 配下へ複製してから使う**。

```bash
ls /home/hakatashi/.cache/sattori-home-worker/title-assets/<game>/   # 世代ディレクトリ名(v-...)を確認
cp -a /home/hakatashi/.cache/sattori-home-worker/title-assets/<game>/v-<hash> \
  /mnt/cache3/sattori-<game>-verify/repro-<jobId>/assets
```

キャッシュの世代ディレクトリは`root`所有だが world-readable(755)なので `sudo` は不要
(コピー先が`hakatashi`所有なので、コピー後のファイルは`hakatashi`所有になる)。

対象タイトルのキャッシュが無い場合(自宅ワーカーがそのタイトルを一度も引き受けていない)は、
`upload-title-assets` skill の手順で S3 から直接ダウンロードするか、`title_assets.py`の
`_download_and_extract()`相当を手動で行う。

## 5. 本番ワーカーイメージで録画する

`entrypoint.py`(S3/DynamoDB/Step Functions前提)を経由せず、`record_thNN.py`を直接呼ぶ。
これなら AWS 認証情報が一切不要で、本番の録画パイプライン(`recording/`パッケージ)は
完全に同じものが動く。**イメージは実際にそのジョブを処理したタグを使うのが理想**だが、
特定できなければ`sattori-worker:latest`(ECRからpull済みのローカルタグ)で構わない
(`docker images`で確認)。

PulseAudio は通常 `entrypoint.py` が起動するが、ここでは経由しないため**コンテナ内で
自分で起動する**必要がある(忘れると`create_null_sink()`が`Connection refused`で
即座に失敗する)。外側のタイムアウトラッパー(`timeout --kill-after=30s`)は
[`decisions/0035`](../../docs/decisions/0035-outer-timeout-wrapper-for-bare-metal-runs.md)
の教訓(D stateでのハング事故)を踏まえ必ず付与する。`--rm`によりコンテナ終了時に
残留プロセスごと確実に片付く。

```bash
D=/mnt/cache3/sattori-<game>-verify/repro-<jobId>
mkdir -p "$D/output/diagnostics" "$D/output/progress"

docker run --rm --name sattori-repro-<game> \
  --cpus 4 \
  -v "$D/assets:/mnt/<game>-assets" \
  -v "$D/replay.rpy:/mnt/replay.rpy:ro" \
  -v "$D/output:/mnt/output" \
  -e WINEPREFIX=/mnt/<game>-assets/prefixes/<game>-wined3d-gl \
  -e SATTORI_GAME_DIR=/mnt/<game>-assets/games/<game> \
  -e SATTORI_MOD_DIR=/mnt/<game>-assets/mods \
  --entrypoint bash \
  "${SATTORI_ECR_REPO}:latest" \
  -c '
    pulseaudio -D --exit-idle-time=-1 --disallow-exit
    sleep 1
    timeout --kill-after=30s 900s python3 record_<game>.py \
      --replay-path /mnt/replay.rpy \
      --output /mnt/output/repro.mp4 \
      --diagnostics-dir /mnt/output/diagnostics \
      --progress-dir /mnt/output/progress \
      --expected-duration-seconds <estimatedDurationSeconds> \
      --max-attempts 3
  ' \
  > "$D/run.log" 2>&1 &
```

バックグラウンドで実行し、`Monitor`ツールでログを監視する(fps暴走・タイムアウト・
処理落ち・例外等の分類キーワードでフィルタする)。**低速録画(th20限定、Issue #68)を
検証する場合は`FPS_LIMIT_TARGET_HZ=30`を`-e`で追加する**(`worker/README.md` §5)。

`record_thNN.py`は`--output`を試行ごとに同じパスで上書きするため、**リトライで破棄
された録画も見たい場合は、各試行が終わって次の試行が始まる前に`output/repro.mp4`を
別名へコピーしておく**(診断スナップショットは`diagnostics/attempt{n}-{classification}.jpg`
で試行ごとに別名なので上書きされない)。

## 6. 結果の整理

コンテナは root で実行されるため、出力ファイルの所有者は root になる。ユーザーが
触れるよう `hakatashi` へ戻し、複製した WINEPREFIX 等(数百MB〜数GB)は検証専用の
使い捨てなので削除する。

```bash
sudo chown -R hakatashi:hakatashi "$D"
sudo rm -rf "$D/assets"   # 本番キャッシュではなく§4で複製した方なので削除して問題ない
```

最終的に `$D` 配下にはリプレイ本体・録画結果(各試行分)・診断スナップショット・
`run.log` だけが残る状態にする。

## 7. 事後確認

- `systemctl is-active sattori-home-worker` が検証開始前と同じ状態に戻っていること
  (このスキル自体はサービスを止めない前提なので、通常は何も変わらない)。
- `docker ps -a --filter name=sattori-repro-<game>` にコンテナが残っていないこと
  (`--rm`を付けていれば正常終了・異常終了いずれでも自動的に消える)。

## 関連

- タイトル資産の中身・キャッシュ機構の詳細 → `upload-title-assets` skill、
  [`decisions/0040`](../../docs/decisions/0040-home-worker-title-assets-cache.md)
- ホスト直接実行(コンテナを使わない経路)の手順 →
  [`docs/runbooks/worker-local-recording.md`](../../docs/runbooks/worker-local-recording.md) §2
- 録画パイプラインの構成・各モジュールの役割 → `worker/docs/recording-package.md`
