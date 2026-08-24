# 0028. 自宅ワーカーは新規claim前に「コンテナのネットワーク名前空間」からAWSへの疎通を確認する

- **状態**: 有効
- **決定日**: 2026-08-24
- **対象**: home-worker / apps/api
- **関連**: Issue #160

自宅サーバーの**ホストは正常だがコンテナだけ外部通信できない**状態になると、
ハートビート（ホストのプロセスが送る）は健全に見え続け、AWS 側は自宅ワーカーへ
ジョブを出し続けてしまう。この決定は「ホストからではなく、実際に `docker run` した
コンテナの中から確認する」という検知方法そのものを固定する。

## 背景

2026-08-24、自宅サーバー（`home-worker/`）の電源復帰後、ホストの VPN policy routing が
Docker ブリッジサブネット（`172.17.0.0/16`）を除外し損ねた状態のまま復帰した。結果:

- ホスト自身の通信は `ip rule` の別ルールで VPN をバイパスしており正常。
- **コンテナから出るパケットだけ**が機能していない WireGuard インターフェースへ送られ、
  ブラックホールになった。
- `home-worker` のハートビート送出はホストのプロセスが行うため正常に届き続け、
  `Launch` Lambda（`apps/api/src/handlers/sfn/launch.ts`）は自宅ワーカーを「新鮮な
  ハートビートがあり空きがある」と判断してオファーを出し続けた。
- デーモンは毎回 claim してコンテナを起動するが、コンテナは AWS（DynamoDB /
  Step Functions）に1バイトも到達できず数秒〜十数秒で異常終了する
  （`HomeWorkerContainerFailed`）。
- これが `MAX_ATTEMPTS`（10回）のほぼ全てを消費するまで繰り返され、EC2 への
  フォールバックが一度も起こらなかった。

## 決定

- **デーモンは `networkCheckIntervalSec`（既定60秒）ごとに、実際に軽量コンテナを
  1つ起動して**（`home-worker/src/network.ts` の `checkContainerNetwork()`）、AWS の
  エンドポイントへ到達できるかを確認する。
- 確認は `docker run --rm curlimages/curl:latest ...` で行い、`curl` の終了コードだけを
  見る（`-f` は付けない——HTTP エラー応答も「到達できている」証拠として成功扱いにする。
  失敗と判定するのは接続不可・タイムアウトのときだけ）。
- 疎通が失われている間は、新規 claim を止め、ハートビートに `accepting: false` を
  立てて自分自身を候補から外す（`home-worker/src/daemon.ts` の
  `#checkNetworkIfDue()` / `tick()`）。**実行中のジョブは止めない**——走り出した録画は
  最後まで完走させるという既存方針（`capacity.ts` のコメント）と同じ理由による。
- 確認自体が例外になった場合（`docker` コマンド不在等）は前回の判定を維持する。
  「確認できない」を「異常」へ倒すと、確認手段自体の一時的な不調で自宅ワーカーが
  恒久的に使われなくなりかねないため。
- 保険として、`apps/api/src/handlers/sfn/handleFailure.ts` の
  `isDeterministicFailure()` に `HomeWorkerContainerFailed` を追加し、この確認を
  取りこぼした場合でも `MAX_ATTEMPTS_DETERMINISTIC`（3回）で早期に打ち切る。

## 根拠

- **ホストからの確認では検知できない**。今回の障害はコンテナのネットワーク名前空間
  だけに起きており、ホストの `curl`/`ping` は正常に成功する。実際にコンテナを起動して
  確認する以外に、この種の障害を再現よく検知する方法が無い。
- **`docker pull` はホストのネットワークで行われる**ため、イメージの pull 自体は
  この障害と無関係に成功する（インシデントのログでも `attempt 2〜9` すべてで
  コンテナは実際に起動し、起動後に落ちている）。したがって確認は「起動できるか」では
  なく「起動したコンテナの中から到達できるか」でなければ意味が無い。
- 疎通確認専用に軽量イメージ（`curlimages/curl`）を使うのは、ワーカーイメージ
  （`worker/`、Wine+Xvfb+ffmpeg 入り）の内部構成（curl 相当のツールがあるか）に
  依存したくないため。「録画パイプラインのロジックは一切持たない」という
  `home-worker/README.md` 冒頭の構造上の分離とも整合する。

## 採らなかった選択肢

- **ホストの `ip rule`/`ip route` を検査して policy routing の不整合を直接判定する**。
  今回の具体的な原因（`throw 172.17.0.0/16` の欠落）にはピンポイントで効くが、
  Linux のネットワーク設定に強く依存し、ホスト側の設定変更（このリポジトリの
  管轄外）のたびに検知ロジックが陳腐化する。実際にコンテナから到達確認する方が
  原因を問わず頑健。
- **同一ワーカーでの連続失敗回数を数えて一時的にオファー対象から外す**（Issue #160
  提案の案2）。疎通確認が根本原因を未然に防ぐため保険としての価値は残るが、
  実装の複雑さに対して疎通確認だけで大半のケースをカバーできると判断し見送った。
  再発すれば改めて検討する。
- **ワーカーイメージ自身に疎通確認を組み込む**（`worker/entrypoint.py` の先頭で
  チェック）。コンテナが起動してしまった後の確認では、`Launch` が既に自宅へ
  オファーを出し切った後になり、EC2 へのフォールバックが `offerWindowSeconds`
  ぶん確実に遅れる。claim 前に判定できる現在の設計のほうが早く EC2 へ流れる。

## 影響範囲

- `home-worker/src/network.ts`（新規）・`home-worker/src/daemon.ts`
  （`#checkNetworkIfDue()`・`tick()`）
- `home-worker/src/config.ts` の `networkCheckIntervalSec`
  （環境変数 `HOME_WORKER_NETWORK_CHECK_INTERVAL_SEC`、`home-worker/README.md` §4.1）
- `apps/api/src/handlers/sfn/handleFailure.ts` の `isDeterministicFailure()`
- 疎通確認先のエンドポイント（DynamoDB）やリージョンの扱いを変える場合は
  `home-worker/src/network.ts` の `networkCheckUrl()` を見直すこと。
