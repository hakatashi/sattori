# 録画ワーカーのローカル開発・検証・イメージ出荷

`worker/` を手元で動かすときの手順。ユニットテストの走らせ方（§1）、AWS 無しでの録画・
配信用変換の直接実行（§2、いわゆるベアメタル直接実行）、ECR へ push するイメージの
ビルド（§3）を扱う。**何がどう動くか（① 参照仕様）は
[`worker/README.md`](../../worker/README.md) にある**ので、初めて触るときは先にそちらを読むこと。

**§2 の直接実行は、本番の Docker 経路には無いホスト側のリスク（Wine プロセスの残存による
ホスト systemd のハング）を伴う**。§2 の強制終了ラッパーの指示は必ず守ること
（[`decisions/0035`](../decisions/0035-outer-timeout-wrapper-for-bare-metal-runs.md)）。

## 1. テスト(`tests/`)

Wine/Xvfb/実ゲームに依存する録画本体(`recording.pipeline.attempt_recording()`)以外の、
純粋なロジック部分(MAD計算・ffmpegコマンド組み立て・fps暴走/重複フレーム率の判定・
配信用変換の解像度/フィルタ組み立て/進捗計算・DynamoDB更新式の組み立て・Spot中断/リバランス
判定・進捗レポートの重複排除等)を pytest でユニットテストする。boto3 呼び出しは
`unittest.mock` でモックし、実際の AWS リソースには接続しない(moto 等の追加依存は導入して
いない)。GitHub Actions の `Test`(`.github/workflows/test.yml`)の `worker-test` ジョブで
push・PR 毎に自動実行される。

```bash
pip install -r requirements-dev.txt && pytest
```

`recording/` パッケージのテストは `tests/test_recording_<モジュール名>.py` と1対1に対応させる
(共有ヘルパは `tests/recording_helpers.py`)。パッケージ内は `from .process import
kill_wine_and_wait` のように名前で import しているため、**monkeypatch は定義側ではなく
「使う側」のモジュールに当てること**(`pipeline.kill_wine_and_wait` であって
`process.kill_wine_and_wait` ではない)。モジュールの一覧は
[`worker/docs/recording-package.md`](../../worker/docs/recording-package.md)。

## 2. ローカルでの実行(ネットワーク不要)

ゲーム資産を配置済みなら S3/DynamoDB 無しで録画本体だけを試せる(低速録画の例は
`worker/README.md` §5)。配信用変換だけなら ffmpeg/ffprobe があれば動く。

```bash
python3 record_th07.py --replay-path /path/to/any.rpy --output /tmp/out.mp4
# 配信用変換のみ(等倍。低速録画の素材は time_scale=2.0 を渡すと等倍へ戻る)
python3 -c "from convert import convert_for_delivery; convert_for_delivery('/tmp/out.mp4', '/tmp/out_delivery.mp4')"
```

音声の録音先となるPulseAudio sinkは`--pulse-sink`未指定ならプロセスIDから採番されるため、複数
タイトルを同時に走らせても音声は混ざらない(ディスプレイ番号もタイトルごとに異なるため映像も
干渉しない)。分離できているかは `pactl list sink-inputs` で各ゲームの接続先を見る
([`reports/2026-08-08-parallel-audio-isolation.md`](../reports/2026-08-08-parallel-audio-isolation.md))。

**手動検証時はOSレベルの強制終了ラッパーを併用すること。** 既知の未修正バグ(th20の低速録画
2並列がハングするIssue #179、その他未知のタイトル固有バグ)により、ゲームプロセスがGPU待ち等の
D state(カーネルレベルで割り込み不可能)に陥り録画処理自体が完全にハングする可能性がある。
`kill_wine_and_wait()`はこのケースをタイムアウト検知しWINEPREFIX配下の残存プロセスをSIGKILLする
フォールバックを持つが(Issue #186)、内部のリトライ/クリーンアップが機能しない未知の経路まで
保証するものではない。本番のDocker経路はジョブ完了後にコンテナごと破棄されるため実害が無いが、
本節のようにホスト上で直接実行する場合はプロセスが確実に終了するよう外側から保険を掛ける:

```bash
timeout --kill-after=30s 600s python3 record_th20.py --replay-path /path/to/any.rpy --output /tmp/out.mp4
```

放置されたWineプロセス(`winedevice.exe`等)がsystem D-Busのシグナル購読を持ったまま残り続けると
D-Busのメッセージキューが枯渇し、ホストのsystemdごとハングする事故が実際に起きている
([`docs/reports/2026-08-27-wine-cleanup-hang-incident.md`](../reports/2026-08-27-wine-cleanup-hang-incident.md))。

## 3. ビルドとECRへのpush

本番のECRリポジトリ名は`sattori-worker`(`infra/lib/sattori-stack.ts`が作成、本体スタックと
同じくeu-south-2)。デプロイ手順全体は `deploy-sattori` skill(**push と deploy の順序を
守ること**)。

```bash
docker build -t <account>.dkr.ecr.eu-south-2.amazonaws.com/sattori-worker:latest worker/
aws ecr get-login-password --region eu-south-2 \
  | docker login --username AWS --password-stdin <account>.dkr.ecr.eu-south-2.amazonaws.com
docker push <account>.dkr.ecr.eu-south-2.amazonaws.com/sattori-worker:latest
```

`worker/assets/`は`.gitignore`対象なので、`docker build`前にビルドコンテキストへ配置すること
(`worker/README.md` §8)。
